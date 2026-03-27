#!/usr/bin/env node
/**
 * Arcate MCP Server — Main Entry Point
 *
 * Exposes Arcate product data (signals, initiatives) as MCP resources
 * and provides write tools (create_signal, link_to_initiative, etc.)
 * to AI agents. Runs as a stdio MCP server launched via npx.
 *
 * Usage:
 *   npx @arcate/mcp-server
 *
 * Required env:
 *   ARCATE_API_KEY              — arc_xxx key from /settings/integrations
 *   ARCATE_SUPABASE_URL         — Your Supabase project URL
 *   ARCATE_SUPABASE_SERVICE_KEY — Supabase service role key (server-side only)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    ErrorCode,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { requireAuth } from './auth.js';
import {
    fetchSignals,
    fetchInitiatives,
    searchSignals,
    searchInitiatives,
    searchCustomers,
    createSignal,
    patchSignal,
    createCustomer,
    createInitiative,
    linkSignalsToInitiative,
    enrichInitiative,
} from './api.js';
import { ArcateMCPError } from './types.js';

// ─── Server Setup ─────────────────────────────────────────────────────────────

const server = new Server(
    { name: 'arcate-mcp', version: '0.1.0' },
    {
        capabilities: {
            resources: {},
            tools: {},
            prompts: {},
        },
    }
);

const API_KEY = process.env.ARCATE_API_KEY;

/**
 * Wrap all handler errors in consistent "Arcate MCP: ..." format.
 * Returns MCP-formatted error content for tool calls.
 */
function handleToolError(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
    const message = err instanceof ArcateMCPError
        ? err.message
        : err instanceof Error
            ? `Arcate MCP: Unexpected error — ${err.message}`
            : 'Arcate MCP: Unknown error occurred.';

    return {
        isError: true,
        content: [{ type: 'text', text: message }],
    };
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
// Prompts are named, reusable templates that appear as clickable guided flows
// in Claude's prompt picker, Cursor slash commands, and Antigravity.
// None require auth — they are static message templates; auth is enforced
// when the agent subsequently calls the tools the prompt instructs it to use.

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
        {
            name: 'arcate:hello',
            description: 'Welcome — get an overview of your Arcate workspace and all available commands.',
        },
        {
            name: 'arcate:ingest',
            description: 'Log customer feedback from a call, interview, or support ticket into Arcate as a structured signal.',
            arguments: [
                { name: 'context', description: 'Raw notes or transcript text to ingest (optional)', required: false },
            ],
        },
        {
            name: 'arcate:triage',
            description: 'Surface unlinked customer signals that have no roadmap initiative yet — find the gaps.',
        },
        {
            name: 'arcate:enrich',
            description: 'Strengthen a roadmap initiative with a refined hypothesis, health metrics, or additional signal evidence.',
            arguments: [
                { name: 'initiative', description: 'Initiative title or keyword to search for (optional)', required: false },
            ],
        },
    ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
        case 'arcate:hello':
            return {
                description: 'Arcate workspace welcome and command guide.',
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: 'Hello Arcate. Please introduce yourself, summarise what you have access to in my workspace, and list the guided commands I can run.',
                        },
                    },
                    {
                        role: 'assistant',
                        content: {
                            type: 'text',
                            text: [
                                '👋 **Welcome to Arcate MCP.**',
                                '',
                                'I have direct access to your product discovery workspace. Here\'s what I can see and do:',
                                '',
                                '**📚 Your Data**',
                                '- `arcate://signals` — Unified Signal Inbox (all customer feedback, friction points, deal-losses)',
                                '- `arcate://initiatives` — Product Roadmap (active initiatives with hypotheses and health metrics)',
                                '',
                                '**🔍 Extract** — Read your workspace',
                                '- `search_signals` — Find signals by keyword, type, or severity',
                                '- `search_customers` — Look up customer accounts',
                                '- `search_initiatives` — Find roadmap initiatives by keyword',
                                '',
                                '**📥 Ingest** — Write back into Arcate',
                                '- `create_signal` — Log new customer feedback as a structured signal',
                                '- `create_customer` — Add a new customer profile (Owners only)',
                                '',
                                '**✨ Enrich** — Strengthen your roadmap',
                                '- `link_to_initiative` — Connect signals to a roadmap initiative with reasoning',
                                '- `enrich_initiative` — Refine hypothesis, metrics, and target outcomes',
                                '',
                                '**🚀 Guided Commands**',
                                '- `arcate:ingest` — Log feedback from a call or interview',
                                '- `arcate:triage` — Find unlinked signals that need attention',
                                '- `arcate:enrich` — Strengthen a specific initiative',
                                '',
                                'What would you like to do first?',
                            ].join('\n'),
                        },
                    },
                ],
            };

        case 'arcate:ingest': {
            const context = args?.context ? `\n\nHere are the raw notes to process:\n\n${args.context}` : '';
            return {
                description: 'Guided flow to ingest customer feedback as a structured signal.',
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Log customer feedback into Arcate as a structured signal. Steps:\n1. If a customer is mentioned, call search_customers to resolve their account_id. If they don't exist, ask me before creating them.\n2. Call search_signals with the core theme to check for duplicates.\n3. If no duplicate, call create_signal with the appropriate type (mention/friction/problem/deal-loss), category (feature/workflow), and severity (Low/Medium/High).\n4. Confirm what was logged and its signal ID.${context}`,
                        },
                    },
                ],
            };
        }

        case 'arcate:triage':
            return {
                description: 'Find unlinked signals with no roadmap initiative assigned.',
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: 'Triage my Arcate signal inbox. Call search_signals with unlinked_only: true and a broad query. Group the results by type and severity. Highlight any High-severity signals and suggest which existing initiatives they might belong to using search_initiatives.',
                        },
                    },
                ],
            };

        case 'arcate:enrich': {
            const initiative = args?.initiative ? `Focus on the initiative matching: "${args.initiative}".` : 'Ask me which initiative to work on, or search for the most evidence-light one.';
            return {
                description: 'Guided flow to enrich a roadmap initiative with hypothesis, metrics, and signals.',
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Enrich a roadmap initiative in Arcate. ${initiative}\n\nSteps:\n1. Call search_initiatives to find the target initiative and read its current brief.\n2. Call search_signals to find relevant unlinked signals.\n3. Call enrich_initiative to update the hypothesis and link relevant signals.\n4. Summarise what changed and what the initiative's evidence strength looks like now.`,
                        },
                    },
                ],
            };
        }

        default:
            throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: '${name}'`);
    }
});

// ─── Resources ────────────────────────────────────────────────────────────────
// Resources are read-only data streams consumed by the LLM as context.

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
        {
            uri: 'arcate://signals',
            name: 'Unified Signal Inbox',
            description: 'All customer feedback, friction points, and feature requests, structured and tagged. Use this as your ground truth for customer evidence.',
            mimeType: 'application/json',
        },
        {
            uri: 'arcate://initiatives',
            name: 'Product Roadmap',
            description: 'Active roadmap initiatives with hypotheses, target outcomes, health metrics, and linked signal counts.',
            mimeType: 'application/json',
        },
    ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    let auth;
    try {
        auth = await requireAuth(API_KEY, 'read');
    } catch (err) {
        throw new McpError(ErrorCode.InvalidRequest, err instanceof Error ? err.message : 'Auth failed');
    }

    const { uri } = request.params;

    if (uri === 'arcate://signals') {
        const signals = await fetchSignals(auth.organizationId);
        return {
            contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(signals, null, 2),
            }],
        };
    }

    if (uri === 'arcate://initiatives') {
        const initiatives = await fetchInitiatives(auth.organizationId);
        return {
            contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(initiatives, null, 2),
            }],
        };
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
});

// ─── Tools ────────────────────────────────────────────────────────────────────
// Tools allow the agent to write data back into Arcate.

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        // ── Read Tools ───────────────────────────────────────────────────────────
        {
            name: 'search_signals',
            description: 'Search signals by keyword and optional filters. Use before creating a signal to check for duplicates.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Keyword to search in signal summaries' },
                    type: { type: 'string', enum: ['mention', 'friction', 'problem', 'deal-loss'], description: 'Optional type filter' },
                    severity: { type: 'string', enum: ['Low', 'Medium', 'High'], description: 'Optional severity filter' },
                    unlinked_only: { type: 'boolean', description: 'If true, only return signals not linked to any initiative' },
                },
                required: ['query'],
            },
        },
        {
            name: 'search_customers',
            description: 'Look up customer accounts by name. Always call this before create_signal to resolve account_id.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Customer name or partial name to search for' },
                },
                required: ['query'],
            },
        },
        {
            name: 'search_initiatives',
            description: 'Search roadmap initiatives by keyword. Use to find existing initiatives before linking signals.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Keyword to match against initiative titles' },
                },
                required: ['query'],
            },
        },

        // ── Write Tools ──────────────────────────────────────────────────────────
        {
            name: 'create_initiative',
            description: 'Create a new roadmap initiative in Arcate. Optionally supply signal_ids to atomically link them on creation. Defaults to state: Triaged. Use search_initiatives first to avoid duplicates.',
            inputSchema: {
                type: 'object',
                properties: {
                    title: { type: 'string', maxLength: 120, description: 'Short, clear initiative title (e.g. "Bulk CSV Export")' },
                    brief: { type: 'string', description: 'Optional hypothesis or context — what problem does this initiative solve and why now?' },
                    signal_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional UUIDs of signals to link immediately. Equivalent to calling link_to_initiative after creation.'
                    },
                },
                required: ['title'],
            },
        },
        {
            name: 'create_signal',
            description: 'Ingest a new customer feedback signal into Arcate. All signals created via MCP are tagged with ingestion_source: mcp for audit. IMPORTANT: category must be exactly "feature" or "workflow".',
            inputSchema: {
                type: 'object',
                properties: {
                    summary: { type: 'string', maxLength: 200, description: 'Short, clear description of the feedback (max 200 chars)' },
                    description: { type: 'string', description: 'Full context, quotes, or notes from the customer interaction' },
                    type: {
                        type: 'string',
                        enum: ['mention', 'friction', 'problem', 'deal-loss'],
                        description: 'mention=loose feedback/request, friction=UX blocker, problem=critical blocker, deal-loss=commercial impact',
                    },
                    category: {
                        type: 'string',
                        enum: ['feature', 'workflow'],
                        description: 'STRICT: Only "feature" (product capability request) or "workflow" (process/UX improvement) are valid.',
                    },
                    severity: {
                        type: 'string',
                        enum: ['Low', 'Medium', 'High'],
                        description: 'Low=nice-to-have, Medium=impacts workflow with workaround, High=blocks critical use case',
                    },
                    source: {
                        type: 'string',
                        enum: ['Slack', 'Intercom', 'E-Mail', 'Support ticket', 'Sales call', 'User interview'],
                        description: 'Where the feedback originated',
                    },
                    account_id: { type: 'string', description: 'Customer ID from search_customers. Strongly recommended.' },
                },
                required: ['summary', 'type', 'category', 'severity'],
            },
        },
        {
            name: 'create_customer',
            description: 'Add a new customer to Arcate. RESTRICTED to Organization Owners. Always call search_customers first to prevent duplicates.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 2, maxLength: 100, description: 'Company or customer name' },
                    website: { type: 'string', description: 'Company website URL (optional)' },
                    tier: {
                        type: 'string',
                        enum: ['Free', 'Standard', 'Premium', 'Enterprise'],
                        description: 'Customer subscription tier',
                    },
                    arr: { type: 'number', minimum: 0, description: 'Annual Recurring Revenue in your base currency' },
                },
                required: ['name'],
            },
        },
        {
            name: 'link_to_initiative',
            description: 'Connect one or more signals to an existing roadmap initiative. Requires a reasoning string explaining why these signals are evidence for the initiative.',
            inputSchema: {
                type: 'object',
                properties: {
                    signal_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Array of signal UUIDs to link',
                    },
                    initiative_id: { type: 'string', description: 'UUID of the target initiative from search_initiatives' },
                    reasoning: { type: 'string', description: 'Why this signal is evidence for this initiative. This is stored for audit.' },
                },
                required: ['signal_ids', 'initiative_id', 'reasoning'],
            },
        },
        {
            name: 'enrich_initiative',
            description: 'Strengthen an initiative with a refined hypothesis, target outcome, health metrics, or additional linked signals. Also supports renaming the initiative title. Use standard metric names when possible.',
            inputSchema: {
                type: 'object',
                properties: {
                    initiative_id: { type: 'string', format: 'uuid', description: 'UUID of the initiative to update' },
                    title: { type: 'string', maxLength: 120, description: 'Rename the initiative title' },
                    refined_hypothesis: { type: 'string', description: 'Updated initiative brief/hypothesis based on new evidence' },
                    target_outcome: {
                        type: 'object',
                        description: 'Defines the expected outcome. Example: { target_description: "Reduce churn by 40% within 90 days", metric: "churn", validation_window_days: 90 }',
                        properties: {
                            target_description: { type: 'string', description: 'Human-readable outcome statement, e.g. "Reduce prompt-ceiling churn by 60% within 90 days of launch"' },
                            metric: { type: 'string', description: 'Metric category: e.g. "revenue", "churn", "activation", "adoption"' },
                            validation_window_days: { type: 'number', description: 'Days to validate the outcome, e.g. 30, 60, 90' },
                        },
                    },
                    health_metrics: {
                        type: 'object',
                        description: 'Key-value pairs where each value MUST be numeric. For percentage metrics, use a plain number (e.g. {"Adoption Rate": 0}). For other types, use {value: number, type: "percentage"|"ratio"|"currency"|"duration"|"number"} (e.g. {"Time to Value": {value: 14, type: "duration"}}). NEVER pass strings as values.',
                        additionalProperties: {
                            oneOf: [
                                { type: 'number' },
                                {
                                    type: 'object',
                                    properties: {
                                        value: { type: 'number' },
                                        type: { type: 'string', enum: ['percentage', 'ratio', 'currency', 'duration', 'number'] },
                                    },
                                    required: ['value', 'type'],
                                },
                            ],
                        },
                    },
                    additional_signal_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Additional signal UUIDs to link to this initiative',
                    },
                    start_date: { type: 'string', format: 'date', description: 'ISO date e.g. 2026-04-01' },
                    target_date: { type: 'string', format: 'date', description: 'ISO date e.g. 2026-06-30' },
                },
                required: ['initiative_id'],
            },
        },
        {
            name: 'patch_signal',
            description: 'Update one or more fields on an existing signal. Use this to correct ingestion errors (wrong account_id, severity, type) without deleting and recreating the signal. Supply only the fields to change.',
            inputSchema: {
                type: 'object',
                properties: {
                    signal_id: { type: 'string', format: 'uuid', description: 'UUID of the signal to patch' },
                    account_id: { type: 'string', description: 'Correct or add the customer account ID' },
                    severity: { type: 'string', enum: ['Low', 'Medium', 'High'], description: 'Updated severity' },
                    type: { type: 'string', enum: ['mention', 'friction', 'problem', 'deal-loss'], description: 'Updated signal type' },
                    summary: { type: 'string', maxLength: 200, description: 'Corrected summary (max 200 chars)' },
                    description: { type: 'string', description: 'Corrected full description' },
                    source: { type: 'string', enum: ['Slack', 'Intercom', 'E-Mail', 'Support ticket', 'Sales call', 'User interview'], description: 'Updated source' },
                },
                required: ['signal_id'],
            },
        },
    ],
}));

// ─── Tool Call Handler ────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // All tools require auth
    const scope = ['create_signal', 'patch_signal', 'create_customer', 'link_to_initiative', 'enrich_initiative', 'create_initiative'].includes(name)
        ? 'write'
        : 'read';

    let auth;
    try {
        auth = await requireAuth(API_KEY, scope);
    } catch (err) {
        return handleToolError(err);
    }

    try {
        switch (name) {
            // ── Read Tools ──────────────────────────────────────────────────────────
            case 'search_signals': {
                const { query, type, severity, unlinked_only } = args as {
                    query: string;
                    type?: string;
                    severity?: string;
                    unlinked_only?: boolean;
                };
                const results = await searchSignals(auth.organizationId, query, {
                    type,
                    severity,
                    linked_initiative_id: unlinked_only ? null : undefined,
                });
                return {
                    content: [{
                        type: 'text',
                        text: results.length === 0
                            ? `No signals found matching "${query}".`
                            : JSON.stringify(results, null, 2),
                    }],
                };
            }

            case 'search_customers': {
                const { query } = args as { query: string };
                const results = await searchCustomers(auth.organizationId, query);
                return {
                    content: [{
                        type: 'text',
                        text: results.length === 0
                            ? `No customers found matching "${query}". Use create_customer if this is a new account.`
                            : JSON.stringify(results, null, 2),
                    }],
                };
            }

            case 'search_initiatives': {
                const { query } = args as { query: string };
                const results = await searchInitiatives(auth.organizationId, query);
                return {
                    content: [{
                        type: 'text',
                        text: results.length === 0
                            ? `No initiatives found matching "${query}".`
                            : JSON.stringify(results, null, 2),
                    }],
                };
            }

            // ── Write Tools ─────────────────────────────────────────────────────────
            case 'create_initiative': {
                const { title, brief, signal_ids } = args as {
                    title: string;
                    brief?: string;
                    signal_ids?: string[];
                };
                const result = await createInitiative(auth.organizationId, auth.userId, { title, brief, signal_ids });
                const linked = signal_ids?.length ? ` Linked ${signal_ids.length} signal(s).` : '';
                return {
                    content: [{
                        type: 'text',
                        text: `Initiative created successfully. ID: ${result.readable_id} (${result.initiative_id}).${linked}`,
                    }],
                };
            }

            case 'create_signal': {
                const input = args as Parameters<typeof createSignal>[2];
                const result = await createSignal(auth.organizationId, auth.userId, input);
                return {
                    content: [{
                        type: 'text',
                        text: `Signal created successfully. ID: ${result.readable_id} (${result.signal_id})`,
                    }],
                };
            }

            case 'create_customer': {
                const input = args as Parameters<typeof createCustomer>[2];
                // Fetch role from users table
                const { createClient } = await import('@supabase/supabase-js');
                const sb = createClient(
                    process.env.ARCATE_SUPABASE_URL!,
                    process.env.ARCATE_SUPABASE_SERVICE_KEY!
                );
                const { data: user } = await sb
                    .from('users')
                    .select('role')
                    .eq('id', auth.userId)
                    .single();

                const result = await createCustomer(auth.organizationId, auth.userId, input, user?.role ?? 'member');
                return {
                    content: [{
                        type: 'text',
                        text: `Customer created successfully. ID: ${result.customer_id}`,
                    }],
                };
            }

            case 'link_to_initiative': {
                const { signal_ids, initiative_id, reasoning } = args as {
                    signal_ids: string[];
                    initiative_id: string;
                    reasoning: string;
                };
                const result = await linkSignalsToInitiative(
                    auth.organizationId,
                    signal_ids,
                    initiative_id,
                    reasoning
                );
                return {
                    content: [{
                        type: 'text',
                        text: `Linked ${result.updated} signal(s) to initiative ${initiative_id}.`,
                    }],
                };
            }

            case 'enrich_initiative': {
                const input = args as Parameters<typeof enrichInitiative>[1];
                await enrichInitiative(auth.organizationId, input);
                return {
                    content: [{
                        type: 'text',
                        text: `Initiative ${input.initiative_id} enriched successfully.`,
                    }],
                };
            }

            case 'patch_signal': {
                const input = args as Parameters<typeof patchSignal>[1];
                const result = await patchSignal(auth.organizationId, input);
                return {
                    content: [{
                        type: 'text',
                        text: `Signal ${result.signal_id} patched successfully.`,
                    }],
                };
            }

            default:
                return handleToolError(new ArcateMCPError(`Unknown tool: '${name}'`));
        }
    } catch (err) {
        return handleToolError(err);
    }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
    // Validate required env vars at startup
    const missing = ['ARCATE_API_KEY', 'ARCATE_SUPABASE_URL', 'ARCATE_SUPABASE_SERVICE_KEY']
        .filter(key => !process.env[key]);

    if (missing.length > 0) {
        process.stderr.write(
            `[Arcate MCP] Missing required environment variables: ${missing.join(', ')}\n` +
            `Set them in your MCP client config under "env".\n`
        );
        process.exit(1);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('[Arcate MCP] Server running. Ready to accept connections.\n');
}

main().catch(err => {
    process.stderr.write(`[Arcate MCP] Fatal error: ${err.message}\n`);
    process.exit(1);
});
