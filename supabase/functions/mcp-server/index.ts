import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Arcate MCP Server — Remote HTTP (JSON-RPC 2.0 over HTTP)
 * v0.13.0: multi-file modular architecture, prompts removed (tools-only)
 *
 * FORMULA: v3.4 — keep in sync with assets/components/core/utils.js
 */

import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from './db.ts';
import { requireAuth, type AuthContext } from './auth.ts';
import { fetchSignalsSummary, getSignal, searchSignals, createSignal, batchCreateSignals, updateSignal } from './signals.ts';
import { fetchInitiativesSummary, searchInitiatives, rankInitiatives, createInitiative, linkSignalsToInitiative, enrichInitiative } from './initiatives.ts';
import { searchCustomers, createCustomer } from './customers.ts';
import { TOOLS } from './tools.ts';

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function cors(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

function rpcOk(id: unknown, result: unknown) { return { jsonrpc: '2.0', id, result }; }
function rpcErr(id: unknown, code: number, message: string) { return { jsonrpc: '2.0', id, error: { code, message } }; }

// ═══════════════════════════════════════════════════════════════════════════════
// JSON-RPC Dispatch
// ═══════════════════════════════════════════════════════════════════════════════

async function dispatch(body: Record<string, unknown>, apiKey: string | null): Promise<unknown> {
  const { id, method, params } = body as { id: unknown; method: string; params: Record<string, unknown> };
  const p = params ?? {};
  if (method === 'initialize') return rpcOk(id, { protocolVersion: '2024-11-05', capabilities: { resources: {}, tools: {} }, serverInfo: { name: 'arcate-mcp', version: '0.13.0' } });
  if (method === 'notifications/initialized' || method === 'ping') return null;
  const writeOps = ['tools/call:create_signal','tools/call:batch_create_signals','tools/call:update_signal','tools/call:create_initiative','tools/call:create_customer','tools/call:link_to_initiative','tools/call:enrich_initiative'];
  const toolName = (p.name as string) ?? '';
  const needsWrite = method === 'tools/call' && writeOps.includes(`tools/call:${toolName}`);
  let auth: AuthContext;
  try { auth = await requireAuth(apiKey, needsWrite ? 'write' : 'read'); }
  catch (err) { return rpcErr(id, -32001, err instanceof Error ? err.message : 'Auth failed'); }
  try {
    if (method === 'resources/list') return rpcOk(id, { resources: [
      { uri: 'arcate://signals', name: 'Signal Inbox Summary', description: 'Counts, severity/type breakdown, and last 10 signals. Use search_signals + get_signal for full exploration.', mimeType: 'application/json' },
      { uri: 'arcate://initiatives', name: 'Roadmap Summary', description: 'Counts, state breakdown, and top 5 initiatives by signal evidence. Use search_initiatives for full exploration.', mimeType: 'application/json' }
    ] });
    if (method === 'resources/read') {
      const uri = p.uri as string;
      if (uri === 'arcate://signals') { const summary = await fetchSignalsSummary(auth.organizationId); return rpcOk(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(summary, null, 2) }] }); }
      if (uri === 'arcate://initiatives') { const summary = await fetchInitiativesSummary(auth.organizationId); return rpcOk(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(summary, null, 2) }] }); }
      return rpcErr(id, -32602, `Unknown resource URI: ${uri}`);
    }
    if (method === 'tools/list') return rpcOk(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const args = (p.arguments ?? {}) as Record<string, unknown>;
      let text = '';
      switch (toolName) {
        case 'search_signals': { const result = await searchSignals(auth.organizationId, args.query as string, { type: args.type as string, severity: args.severity as string, linked_initiative_id: args.unlinked_only ? null : undefined }); const note = result.meta.truncated ? `\n\n⚠️ Showing ${result.meta.returned} of ${result.meta.total_matching} matching signals. Narrow with type/severity filters or use get_signal for details.` : ''; text = result.signals.length ? JSON.stringify(result, null, 2) + note : `No signals found matching "${args.query}".`; break; }
        case 'get_signal': { const signal = await getSignal(auth.organizationId, args.signal_id as string); text = JSON.stringify(signal, null, 2); break; }
        case 'search_customers': { const results = await searchCustomers(auth.organizationId, args.query as string); text = results.length ? JSON.stringify(results, null, 2) : `No customers found matching "${args.query}". Use create_customer if new.`; break; }
        case 'search_initiatives': { const result = await searchInitiatives(auth.organizationId, args.query as string, auth.hasRevenueScoring); const note = result.meta?.truncated ? `\n\n⚠️ Showing ${result.meta.returned} of ${result.meta.total_matching} matching initiatives.` : ''; text = result.initiatives.length ? JSON.stringify(result, null, 2) + note : `No initiatives found matching "${args.query}".`; break; }
        case 'rank_initiatives': { const result = await rankInitiatives(auth.organizationId, auth.hasRevenueScoring); text = JSON.stringify(result, null, 2); break; }
        case 'create_initiative': { const result = await createInitiative(auth.organizationId, auth.userId, args); const linkedMsg = result.linked > 0 ? ` Linked ${result.linked} signal(s).` : ''; text = `Initiative created. ID: ${result.display_id} (${result.id}).${linkedMsg}`; break; }
        case 'create_signal': { const result = await createSignal(auth.organizationId, auth.userId, args); text = `Signal created. ID: ${result.display_id} (${result.id})`; break; }
        case 'batch_create_signals': { const { signals } = args as { signals: Record<string, unknown>[] }; const result = await batchCreateSignals(auth.organizationId, auth.userId, signals); text = `Batch complete: ${result.created} signal(s) created. IDs: ${result.ids.slice(0, 5).map((s: any) => s.display_id).join(', ')}${result.created > 5 ? ` …+${result.created - 5} more` : ''}`; break; }
        case 'update_signal': { const result = await updateSignal(auth.organizationId, args); text = `Signal ${result.id} updated successfully.`; break; }
        case 'create_customer': { const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY); const { data: user } = await sb.from('users').select('role').eq('id', auth.userId).single(); const result = await createCustomer(auth.organizationId, auth.userId, args, (user as any)?.role ?? 'member'); text = `Customer created. ID: ${result.id}`; break; }
        case 'link_to_initiative': { const result = await linkSignalsToInitiative(auth.organizationId, args.signal_ids as string[], args.initiative_id as string, args.reasoning as string); text = `Linked ${result.updated} signal(s) to initiative ${args.initiative_id}.`; break; }
        case 'enrich_initiative': { await enrichInitiative(auth.organizationId, args); text = `Initiative ${args.initiative_id} enriched successfully.`; break; }
        default: return rpcErr(id, -32601, `Unknown tool: '${toolName}'`);
      }
      return rpcOk(id, { content: [{ type: 'text', text }] });
    }
    if (method === 'prompts/list') return rpcOk(id, { prompts: [] });
    if (method === 'prompts/get') return rpcErr(id, -32601, 'Prompts removed in v0.13.0. Use tools directly.');
    return rpcErr(id, -32601, `Method not found: '${method}'`);
  } catch (err) { return rpcErr(id, -32000, err instanceof Error ? err.message : 'Internal error'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP Server
// ═══════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '*';
  const corsH = cors(origin);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsH });
  if (req.method === 'GET') return json({ name: 'Arcate MCP Server', version: '0.13.0', protocol: 'Model Context Protocol (JSON-RPC 2.0 over HTTP)', docs: 'https://arcate.io/arcate-mcp', tools: TOOLS.map(t => t.name), resources: ['arcate://signals', 'arcate://initiatives'], configure: 'Add this URL to your MCP client config with Authorization: Bearer arc_...' }, 200, corsH);
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, corsH);
  const auth = req.headers.get('authorization') ?? '';
  const apiKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  let body: unknown;
  try { body = await req.json(); } catch { return json(rpcErr(null, -32700, 'Parse error: invalid JSON'), 400, corsH); }
  if (Array.isArray(body)) { const results = await Promise.all(body.map(item => dispatch(item as Record<string, unknown>, apiKey))); return json(results.filter(r => r !== null), 200, { ...corsH, 'Content-Type': 'application/json' }); }
  const result = await dispatch(body as Record<string, unknown>, apiKey);
  if (result === null) return new Response(null, { status: 204, headers: corsH });
  return json(result, 200, { ...corsH, 'Content-Type': 'application/json' });
});
