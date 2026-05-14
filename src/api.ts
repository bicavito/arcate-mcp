/**
 * Arcate MCP Server — Supabase Data Client
 *
 * All data access methods used by the MCP tool handlers.
 * Every query is hard-scoped to the authenticated organization_id.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
    Signal, SignalSummary, Initiative, Customer,
    SignalsSummaryResponse, InitiativesSummaryResponse, SearchResultMeta,
    CreateSignalInput, PatchSignalInput, CreateCustomerInput, EnrichInitiativeInput, CreateInitiativeInput,
    SIGNAL_CATEGORIES, SIGNAL_TYPES, SIGNAL_SEVERITIES, SIGNAL_SOURCES,
    ArcateMCPError
} from './types.js';

// ─── Client Factory ───────────────────────────────────────────────────────────

function getClient(): SupabaseClient {
    const url = process.env.ARCATE_SUPABASE_URL;
    const key = process.env.ARCATE_SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new ArcateMCPError('Server misconfiguration: Supabase env vars missing.');
    return createClient(url, key);
}

// ─── Signals ──────────────────────────────────────────────────────────────────

/** Lean select clause shared by search/list queries (no description). */
const SIGNAL_LEAN_SELECT = 'id, display_id, summary, type, category, severity, source, status, account_id, linked_initiative_id, organization_id, created_at, ingestion_source';

/** Full select clause for single-signal detail. */
const SIGNAL_FULL_SELECT = 'id, display_id, summary, description, type, category, severity, source, status, account_id, linked_initiative_id, organization_id, created_by, created_at, ingestion_source, raw_payload';

/**
 * Resource handler: returns a summary of the signal corpus for orientation.
 * Replaces the old 200-signal full dump with counts + last 10 lean signals.
 */
export async function fetchSignalsSummary(organizationId: string): Promise<SignalsSummaryResponse> {
    const supabase = getClient();

    // Total count
    const { count: totalSignals, error: countErr } = await supabase
        .from('signals')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId);
    if (countErr) throw new ArcateMCPError(`Failed to count signals: ${countErr.message}`);

    // Unlinked count
    const { count: unlinkedSignals, error: unlinkErr } = await supabase
        .from('signals')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .is('linked_initiative_id', null);
    if (unlinkErr) throw new ArcateMCPError(`Failed to count unlinked signals: ${unlinkErr.message}`);

    // Recent 10 lean signals
    const { data: recent, error: recentErr } = await supabase
        .from('signals')
        .select(SIGNAL_LEAN_SELECT)
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
        .limit(10);
    if (recentErr) throw new ArcateMCPError(`Failed to fetch recent signals: ${recentErr.message}`);

    // Severity breakdown (from recent+all signals — count-based)
    const { data: allLean, error: allErr } = await supabase
        .from('signals')
        .select('severity, type')
        .eq('organization_id', organizationId);
    if (allErr) throw new ArcateMCPError(`Failed to fetch signal breakdown: ${allErr.message}`);

    const bySeverity = { High: 0, Medium: 0, Low: 0 };
    const byType: Record<string, number> = {};
    for (const s of allLean ?? []) {
        if (s.severity in bySeverity) bySeverity[s.severity as keyof typeof bySeverity]++;
        byType[s.type] = (byType[s.type] ?? 0) + 1;
    }

    return {
        total_signals: totalSignals ?? 0,
        unlinked_signals: unlinkedSignals ?? 0,
        by_severity: bySeverity,
        by_type: byType,
        recent: (recent ?? []) as SignalSummary[],
    };
}

/**
 * Detail tool: returns the full payload for a single signal by ID.
 */
export async function getSignal(organizationId: string, signalId: string): Promise<Signal> {
    const supabase = getClient();
    const { data, error } = await supabase
        .from('signals')
        .select(SIGNAL_FULL_SELECT)
        .eq('id', signalId)
        .eq('organization_id', organizationId)
        .single();

    if (error || !data) throw new ArcateMCPError(`Signal '${signalId}' not found or access denied.`);
    return data as Signal;
}

/**
 * Search tool: returns lean signals (no description) with truncation metadata.
 * Use get_signal to fetch full detail for a specific signal.
 */
export async function searchSignals(
    organizationId: string,
    query: string,
    filters?: { linked_initiative_id?: string | null; type?: string; severity?: string }
): Promise<{ signals: SignalSummary[]; meta: SearchResultMeta }> {
    const supabase = getClient();
    const LIMIT = 100;

    // Count total matching first
    let countReq = supabase
        .from('signals')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .ilike('summary', `%${query}%`);

    if (filters?.type) countReq = countReq.eq('type', filters.type);
    if (filters?.severity) countReq = countReq.eq('severity', filters.severity);
    if (filters?.linked_initiative_id === null) countReq = countReq.is('linked_initiative_id', null);
    else if (filters?.linked_initiative_id) countReq = countReq.eq('linked_initiative_id', filters.linked_initiative_id);

    const { count: totalMatching, error: countErr } = await countReq;
    if (countErr) throw new ArcateMCPError(`Signal count failed: ${countErr.message}`);

    // Fetch lean results
    let req = supabase
        .from('signals')
        .select(SIGNAL_LEAN_SELECT)
        .eq('organization_id', organizationId)
        .ilike('summary', `%${query}%`)
        .order('created_at', { ascending: false })
        .limit(LIMIT);

    if (filters?.type) req = req.eq('type', filters.type);
    if (filters?.severity) req = req.eq('severity', filters.severity);
    if (filters?.linked_initiative_id === null) req = req.is('linked_initiative_id', null);
    else if (filters?.linked_initiative_id) req = req.eq('linked_initiative_id', filters.linked_initiative_id);

    const { data, error } = await req;
    if (error) throw new ArcateMCPError(`Signal search failed: ${error.message}`);

    const results = (data ?? []) as SignalSummary[];
    const total = totalMatching ?? results.length;

    return {
        signals: results,
        meta: {
            returned: results.length,
            total_matching: total,
            truncated: total > LIMIT,
        },
    };
}

export async function createSignal(
    organizationId: string,
    userId: string,
    input: CreateSignalInput
): Promise<{ signal_id: string; display_id: string }> {
    // Validate enums server-side (LLMs can hallucinate values)
    if (!SIGNAL_TYPES.includes(input.type)) {
        throw new ArcateMCPError(
            `Invalid type '${input.type}'. Must be one of: ${SIGNAL_TYPES.join(', ')}.`
        );
    }
    if (!SIGNAL_CATEGORIES.includes(input.category)) {
        throw new ArcateMCPError(
            `Invalid category '${input.category}'. Only '${SIGNAL_CATEGORIES.join("' and '")}' are permitted.`
        );
    }
    if (!SIGNAL_SEVERITIES.includes(input.severity)) {
        throw new ArcateMCPError(
            `Invalid severity '${input.severity}'. Must be one of: ${SIGNAL_SEVERITIES.join(', ')}.`
        );
    }

    const supabase = getClient();

    // display_id is generated by a DB BEFORE INSERT trigger
    const payload = {
        id: crypto.randomUUID(),
        summary: input.summary.trim(),
        description: input.description?.trim(),
        type: input.type,
        category: input.category,
        severity: input.severity,
        source: input.source ?? 'mcp',
        account_id: input.account_id,
        status: 'New',
        organization_id: organizationId,
        created_by: userId,
        ingestion_source: 'mcp',
        raw_payload: { mcp_tool: 'create_signal', timestamp: new Date().toISOString() },
        created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
        .from('signals')
        .insert([payload])
        .select('id, display_id')
        .single();

    if (error) throw new ArcateMCPError(`Failed to create signal: ${error.message}`);
    return { signal_id: data.id, display_id: data.display_id };
}

export async function updateSignal(
    organizationId: string,
    input: PatchSignalInput
): Promise<{ signal_id: string }> {
    // Validate optional enums if provided
    if (input.type && !SIGNAL_TYPES.includes(input.type)) {
        throw new ArcateMCPError(`Invalid type '${input.type}'. Must be one of: ${SIGNAL_TYPES.join(', ')}.`);
    }
    if (input.severity && !SIGNAL_SEVERITIES.includes(input.severity)) {
        throw new ArcateMCPError(`Invalid severity '${input.severity}'. Must be one of: ${SIGNAL_SEVERITIES.join(', ')}.`);
    }

    const updates: Record<string, unknown> = {};
    if (input.account_id !== undefined) updates['account_id'] = input.account_id;
    if (input.severity) updates['severity'] = input.severity;
    if (input.type) updates['type'] = input.type;
    if (input.summary) updates['summary'] = input.summary.trim();
    if (input.description !== undefined) updates['description'] = input.description?.trim();
    if (input.source) updates['source'] = input.source;

    if (Object.keys(updates).length === 0) {
        throw new ArcateMCPError('No fields provided to update. Supply at least one: account_id, severity, type, summary, description, source.');
    }

    const supabase = getClient();
    const { data, error } = await supabase
        .from('signals')
        .update(updates)
        .eq('id', input.signal_id)
        .eq('organization_id', organizationId)
        .select('id')
        .single();

    if (error || !data) throw new ArcateMCPError(`Failed to update signal '${input.signal_id}': ${error?.message ?? 'not found or access denied'}`);
    return { signal_id: data.id };
}

export async function batchCreateSignals(
    organizationId: string,
    userId: string,
    signals: CreateSignalInput[]
): Promise<{ created: number; ids: { signal_id: string; display_id: string }[] }> {
    if (!signals?.length) throw new ArcateMCPError('signals array must not be empty.');
    if (signals.length > 100) throw new ArcateMCPError('Maximum 100 signals per batch. Split into multiple batches.');

    const payloads = signals.map(input => {
        if (!SIGNAL_TYPES.includes(input.type)) throw new ArcateMCPError(`Invalid type '${input.type}' in batch. Must be one of: ${SIGNAL_TYPES.join(', ')}.`);
        if (!SIGNAL_CATEGORIES.includes(input.category)) throw new ArcateMCPError(`Invalid category '${input.category}'. Only 'feature' and 'workflow' are permitted.`);
        if (!SIGNAL_SEVERITIES.includes(input.severity)) throw new ArcateMCPError(`Invalid severity '${input.severity}'. Must be Low, Medium, or High.`);
        return {
            id: crypto.randomUUID(),
            summary: input.summary.trim(),
            description: input.description?.trim(),
            type: input.type,
            category: input.category,
            severity: input.severity,
            source: input.source ?? 'mcp',
            account_id: input.account_id,
            status: 'New',
            organization_id: organizationId,
            created_by: userId,
            ingestion_source: 'mcp' as const,
            raw_payload: { mcp_tool: 'batch_create_signals', timestamp: new Date().toISOString() },
            created_at: new Date().toISOString(),
        };
    });

    const supabase = getClient();
    const { data, error } = await supabase
        .from('signals')
        .insert(payloads)
        .select('id, display_id');

    if (error) throw new ArcateMCPError(`Batch signal creation failed: ${error.message}`);
    return {
        created: data?.length ?? 0,
        ids: (data ?? []).map(d => ({ signal_id: d.id, display_id: d.display_id })),
    };
}

// ─── Initiatives ──────────────────────────────────────────────────────────────

/**
 * Resource handler: returns a summary of the initiative corpus.
 * Includes counts by state and top initiatives by linked signal count.
 */
export async function fetchInitiativesSummary(organizationId: string): Promise<InitiativesSummaryResponse> {
    const supabase = getClient();

    // All initiatives (lean — just id, display_id, title, state)
    const { data: all, error: allErr } = await supabase
        .from('initiatives')
        .select('id, display_id, title, state')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false });
    if (allErr) throw new ArcateMCPError(`Failed to fetch initiatives: ${allErr.message}`);

    const initiatives = all ?? [];

    // State breakdown
    const byState: Record<string, number> = {};
    for (const i of initiatives) {
        byState[i.state] = (byState[i.state] ?? 0) + 1;
    }

    // Count linked signals per initiative
    const topWithCounts: { id: string; display_id: string; title: string; state: string; signal_count: number }[] = [];
    for (const init of initiatives) {
        const { count, error: cErr } = await supabase
            .from('signals')
            .select('id', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .eq('linked_initiative_id', init.id);
        topWithCounts.push({
            id: init.id,
            display_id: init.display_id,
            title: init.title,
            state: init.state,
            signal_count: count ?? 0,
        });
    }

    // Sort by signal count descending, take top 5
    topWithCounts.sort((a, b) => b.signal_count - a.signal_count);

    return {
        total_initiatives: initiatives.length,
        by_state: byState,
        top_by_signal_count: topWithCounts.slice(0, 5),
    };
}

/**
 * Search tool: returns full initiative objects with truncation metadata.
 */
export async function searchInitiatives(
    organizationId: string,
    query: string
): Promise<{ initiatives: Initiative[]; meta: SearchResultMeta }> {
    const supabase = getClient();
    const LIMIT = 50;

    // Count total
    const { count: totalMatching, error: countErr } = await supabase
        .from('initiatives')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .ilike('title', `%${query}%`);
    if (countErr) throw new ArcateMCPError(`Initiative count failed: ${countErr.message}`);

    // Fetch results
    const { data, error } = await supabase
        .from('initiatives')
        .select('id, display_id, title, brief, state, target_outcome, health_metrics, organization_id, created_at')
        .eq('organization_id', organizationId)
        .ilike('title', `%${query}%`)
        .order('created_at', { ascending: false })
        .limit(LIMIT);
    if (error) throw new ArcateMCPError(`Initiative search failed: ${error.message}`);

    const results = (data ?? []) as Initiative[];
    const total = totalMatching ?? results.length;

    return {
        initiatives: results,
        meta: {
            returned: results.length,
            total_matching: total,
            truncated: total > LIMIT,
        },
    };
}

export async function createInitiative(
    organizationId: string,
    userId: string,
    input: CreateInitiativeInput
): Promise<{ initiative_id: string; display_id: string }> {
    if (!input.title?.trim()) {
        throw new ArcateMCPError('title is required and cannot be empty.');
    }

    const supabase = getClient();

    // display_id is generated by a DB BEFORE INSERT trigger
    const id = crypto.randomUUID();

    const { data, error } = await supabase
        .from('initiatives')
        .insert([{
            id,
            title: input.title.trim(),
            brief: input.brief?.trim() ?? null,
            state: 'Triaged',
            organization_id: organizationId,
            created_by: userId,
            created_at: new Date().toISOString(),
        }])
        .select('id, display_id')
        .single();

    if (error) throw new ArcateMCPError(`Failed to create initiative: ${error.message}`);

    // Optionally link signals in one batch update
    if (input.signal_ids && input.signal_ids.length > 0) {
        const { error: linkError } = await supabase
            .from('signals')
            .update({ linked_initiative_id: data.id, status: 'In Progress' })
            .in('id', input.signal_ids)
            .eq('organization_id', organizationId);

        if (linkError) {
            // Initiative was created — warn but don't fail
            console.warn(`[Arcate MCP] create_initiative: signals linked partially — ${linkError.message}`);
        }
    }

    return { initiative_id: data.id, display_id: data.display_id };
}

export async function linkSignalsToInitiative(
    organizationId: string,
    signalIds: string[],
    initiativeId: string,
    reasoning: string
): Promise<{ updated: number }> {
    const supabase = getClient();

    // Verify initiative belongs to org
    const { data: initiative, error: initErr } = await supabase
        .from('initiatives')
        .select('id')
        .eq('id', initiativeId)
        .eq('organization_id', organizationId)
        .single();

    if (initErr || !initiative) {
        throw new ArcateMCPError(`Initiative '${initiativeId}' not found in your organization.`);
    }

    const { data: updated, error: updateError } = await supabase
        .from('signals')
        .update({ linked_initiative_id: initiativeId, status: 'In Progress' })
        .in('id', signalIds)
        .eq('organization_id', organizationId)
        .select('id');

    if (updateError) throw new ArcateMCPError(`Failed to link signals: ${updateError.message}`);

    // Log the reasoning to each signal's raw_payload separately
    for (const signalId of signalIds) {
        await supabase
            .from('signals')
            .update({ raw_payload: { mcp_tool: 'link_to_initiative', reasoning, initiative_id: initiativeId } })
            .eq('id', signalId)
            .eq('organization_id', organizationId);
    }

    return { updated: updated?.length ?? 0 };

}

export async function enrichInitiative(
    organizationId: string,
    input: EnrichInitiativeInput
): Promise<{ success: boolean }> {
    const supabase = getClient();

    // Verify initiative belongs to org
    const { data: initiative, error: fetchErr } = await supabase
        .from('initiatives')
        .select('id, health_metrics, target_outcome')
        .eq('id', input.initiative_id)
        .eq('organization_id', organizationId)
        .single();

    if (fetchErr || !initiative) {
        throw new ArcateMCPError(`Initiative '${input.initiative_id}' not found.`);
    }

    // Validate health_metrics values are numeric (reject strings that LLMs hallucinate)
    const newMetrics = input.health_metrics ?? {};
    for (const [key, val] of Object.entries(newMetrics)) {
        if (typeof val === 'number') continue;
        if (typeof val === 'object' && val !== null && 'value' in val && typeof (val as any).value === 'number') continue;
        throw new ArcateMCPError(
            `Invalid health_metric value for "${key}": expected a number or {value: number, type: string}, got ${typeof val}. ` +
            `Example: {"Adoption Rate": 0} or {"Time to Value": {value: 14, type: "duration"}}`
        );
    }

    // Merge health_metrics (don't overwrite existing, merge new)
    const existingMetrics = (initiative.health_metrics ?? {}) as Record<string, unknown>;
    const mergedMetrics = { ...existingMetrics, ...newMetrics };

    const updates: Record<string, unknown> = {};
    if (input.title) updates['title'] = input.title.trim();
    if (input.refined_hypothesis) updates['brief'] = input.refined_hypothesis;
    if (input.target_outcome) updates['target_outcome'] = input.target_outcome;
    if (Object.keys(newMetrics).length > 0) updates['health_metrics'] = mergedMetrics;
    if (input.start_date) updates['start_date'] = input.start_date;
    if (input.target_date) updates['target_date'] = input.target_date;

    if (Object.keys(updates).length === 0) {
        throw new ArcateMCPError('No updates provided to enrich_initiative.');
    }

    const { error } = await supabase
        .from('initiatives')
        .update(updates)
        .eq('id', input.initiative_id)
        .eq('organization_id', organizationId);

    if (error) throw new ArcateMCPError(`Failed to enrich initiative: ${error.message}`);

    // Link additional signals if provided
    if (input.additional_signal_ids && input.additional_signal_ids.length > 0) {
        await supabase
            .from('signals')
            .update({ linked_initiative_id: input.initiative_id, status: 'In Progress' })
            .in('id', input.additional_signal_ids)
            .eq('organization_id', organizationId);
    }

    return { success: true };
}

// ─── Customers ────────────────────────────────────────────────────────────────

export async function searchCustomers(organizationId: string, query: string): Promise<Customer[]> {
    const supabase = getClient();
    const { data, error } = await supabase
        .from('customers')
        .select('id, name, website, tier, arr, health_score, status, organization_id, created_at')
        .eq('organization_id', organizationId)
        .ilike('name', `%${query}%`)
        .limit(10);

    if (error) throw new ArcateMCPError(`Customer search failed: ${error.message}`);
    return data ?? [];
}

export async function createCustomer(
    organizationId: string,
    userId: string,
    input: CreateCustomerInput,
    userRole: string
): Promise<{ customer_id: string }> {
    // Customer creation is owner-only (financial data integrity)
    if (userRole !== 'owner') {
        throw new ArcateMCPError('create_customer is restricted to Organization Owners to maintain financial data integrity.');
    }

    // Fuzzy duplicate check (basic substring, Levenshtein would need a lib)
    const existing = await searchCustomers(organizationId, input.name.substring(0, 5));
    const nameLower = input.name.toLowerCase();
    const duplicate = existing.find(c =>
        c.name.toLowerCase().includes(nameLower) || nameLower.includes(c.name.toLowerCase())
    );
    if (duplicate) {
        throw new ArcateMCPError(
            `Potential duplicate customer found: "${duplicate.name}" (id: ${duplicate.id}). Use the existing record or provide a more specific name.`
        );
    }

    const supabase = getClient();
    const id = `cus_arc_${crypto.randomUUID().split('-')[0]}`;

    const { data, error } = await supabase
        .from('customers')
        .insert([{
            id,
            name: input.name.trim(),
            website: input.website,
            tier: input.tier ?? 'Standard',
            arr: input.arr ?? 0,
            organization_id: organizationId,
            created_at: new Date().toISOString(),
        }])
        .select('id')
        .single();

    if (error) throw new ArcateMCPError(`Failed to create customer: ${error.message}`);
    return { customer_id: data.id };
}
