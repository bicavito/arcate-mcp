import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Arcate MCP Server — Remote HTTP (JSON-RPC 2.0 over HTTP)
 * v0.11.0: lean resources, get_signal detail tool, truncation transparency
 *
 * FORMULA: v3.4 — keep in sync with assets/components/core/utils.js
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

interface AuthContext { organizationId: string; userId: string; scopes: string[]; hasRevenueScoring: boolean; }

async function validateApiKey(key: string): Promise<AuthContext | null> {
  if (!key?.startsWith('arc_')) return null;
  const parts = key.split('_');
  if (parts.length < 3) return null;
  const keyPrefix = `arc_${parts[1]}_${parts[2].substring(0, 8)}`;
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: keys } = await sb.from('api_keys')
    .select('id, key_hash, organization_id, user_id, scopes, revoked_at')
    .eq('key_prefix', keyPrefix).is('revoked_at', null).limit(5);
  if (!keys?.length) return null;
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(key));
  const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  for (const k of keys) {
    if (k.key_hash === hash) {
      sb.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', k.id).then(() => {}).catch(() => {});
      return { organizationId: k.organization_id, userId: k.user_id, scopes: k.scopes ?? ['read', 'write'], hasRevenueScoring: false };
    }
  }
  return null;
}

async function requireAuth(apiKey: string | null, scope?: 'read' | 'write'): Promise<AuthContext> {
  if (!apiKey) throw new Error('No API key provided. Add Authorization: Bearer arc_... to your MCP client config.');
  const auth = await validateApiKey(apiKey);
  if (!auth) throw new Error('Invalid or revoked API key.');
  if (scope && !auth.scopes.includes(scope)) throw new Error(`This operation requires '${scope}' scope.`);
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: org } = await sb.from('organizations').select('capabilities, billing_status').eq('id', auth.organizationId).single();
  if (!org) throw new Error('Organization not found.');
  if (org.capabilities?.use_mcp !== true || org.billing_status !== 'active') {
    throw new Error('MCP Connect requires an active Evidence subscription. Visit /settings/billing to upgrade.');
  }
  auth.hasRevenueScoring = org.capabilities?.revenue_scoring === true;
  return auth;
}

const SIGNAL_TYPES = ['mention', 'friction', 'problem', 'deal-loss'];
const SIGNAL_CATEGORIES = ['feature', 'workflow'];
const SIGNAL_SEVERITIES = ['Low', 'Medium', 'High'];

function db() { return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY); }

// ═══════════════════════════════════════════════════════════════════════════════
// Data Access — Signals
// ═══════════════════════════════════════════════════════════════════════════════

/** Lean select — no description field */
const SIGNAL_LEAN = 'id,display_id,summary,type,category,severity,source,status,account_id,linked_initiative_id,organization_id,created_at,ingestion_source';
/** Full select — for get_signal detail and internal use */
const SIGNAL_FULL = 'id,display_id,summary,description,type,category,severity,source,status,account_id,linked_initiative_id,organization_id,created_by,created_at,ingestion_source,raw_payload';

/** Internal use by rankInitiatives — full signals for impact calculation */
async function fetchSignals(orgId: string) {
  const { data, error } = await db().from('signals')
    .select(SIGNAL_FULL)
    .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(500);
  if (error) throw new Error(`Failed to fetch signals: ${error.message}`);
  return data ?? [];
}

/** Resource handler — lean summary for orientation */
async function fetchSignalsSummary(orgId: string) {
  const s = db();
  const [totalRes, unlinkedRes, recentRes, breakdownRes] = await Promise.all([
    s.from('signals').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    s.from('signals').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).is('linked_initiative_id', null),
    s.from('signals').select(SIGNAL_LEAN).eq('organization_id', orgId).order('created_at', { ascending: false }).limit(10),
    s.from('signals').select('severity, type').eq('organization_id', orgId),
  ]);
  if (totalRes.error) throw new Error(totalRes.error.message);
  const bySeverity: Record<string, number> = { High: 0, Medium: 0, Low: 0 };
  const byType: Record<string, number> = {};
  for (const r of breakdownRes.data ?? []) {
    if (r.severity in bySeverity) bySeverity[r.severity]++;
    byType[r.type] = (byType[r.type] ?? 0) + 1;
  }
  return {
    total_signals: totalRes.count ?? 0,
    unlinked_signals: unlinkedRes.count ?? 0,
    by_severity: bySeverity,
    by_type: byType,
    recent: recentRes.data ?? [],
  };
}

/** Detail tool — full single signal */
async function getSignal(orgId: string, signalId: string) {
  const { data, error } = await db().from('signals')
    .select(SIGNAL_FULL)
    .eq('id', signalId).eq('organization_id', orgId).single();
  if (error || !data) throw new Error(`Signal '${signalId}' not found or access denied.`);
  return data;
}

/** Search — lean results + truncation metadata */
async function searchSignals(orgId: string, query: string, filters?: { type?: string; severity?: string; linked_initiative_id?: string | null }) {
  const LIMIT = 100;
  let countReq = db().from('signals').select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId).ilike('summary', `%${query}%`);
  if (filters?.type) countReq = countReq.eq('type', filters.type);
  if (filters?.severity) countReq = countReq.eq('severity', filters.severity);
  if (filters?.linked_initiative_id === null) countReq = countReq.is('linked_initiative_id', null);
  else if (filters?.linked_initiative_id) countReq = countReq.eq('linked_initiative_id', filters.linked_initiative_id);

  let req = db().from('signals').select(SIGNAL_LEAN)
    .eq('organization_id', orgId).ilike('summary', `%${query}%`)
    .order('created_at', { ascending: false }).limit(LIMIT);
  if (filters?.type) req = req.eq('type', filters.type);
  if (filters?.severity) req = req.eq('severity', filters.severity);
  if (filters?.linked_initiative_id === null) req = req.is('linked_initiative_id', null);
  else if (filters?.linked_initiative_id) req = req.eq('linked_initiative_id', filters.linked_initiative_id);

  const [countRes, dataRes] = await Promise.all([countReq, req]);
  if (dataRes.error) throw new Error(`Signal search failed: ${dataRes.error.message}`);
  const signals = dataRes.data ?? [];
  const total = countRes.count ?? signals.length;
  return { signals, meta: { returned: signals.length, total_matching: total, truncated: total > LIMIT } };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Data Access — Initiatives
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchInitiatives(orgId: string) {
  const { data, error } = await db().from('initiatives')
    .select('id,display_id,title,brief,state,target_outcome,health_metrics,start_date,due_date,organization_id,created_at')
    .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(100);
  if (error) throw new Error(`Failed to fetch initiatives: ${error.message}`);
  return data ?? [];
}

/** Resource handler — lean summary for orientation */
async function fetchInitiativesSummary(orgId: string) {
  const all = await fetchInitiatives(orgId);
  const byState: Record<string, number> = {};
  for (const i of all) byState[i.state] = (byState[i.state] ?? 0) + 1;
  // Count signals per initiative
  const top: { id: string; display_id: string; title: string; state: string; signal_count: number }[] = [];
  for (const init of all) {
    const { count } = await db().from('signals').select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId).eq('linked_initiative_id', init.id);
    top.push({ id: init.id, display_id: init.display_id, title: init.title, state: init.state, signal_count: count ?? 0 });
  }
  top.sort((a, b) => b.signal_count - a.signal_count);
  return { total_initiatives: all.length, by_state: byState, top_by_signal_count: top.slice(0, 5) };
}

async function searchInitiatives(orgId: string, query: string, hasRevenueScoring: boolean) {
  const LIMIT = 50;
  const { count: totalMatching } = await db().from('initiatives')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId).ilike('title', `%${query}%`);

  const { data, error } = await db().from('initiatives')
    .select('id,display_id,title,brief,state,target_outcome,health_metrics,start_date,due_date,organization_id,created_at')
    .eq('organization_id', orgId).ilike('title', `%${query}%`)
    .order('created_at', { ascending: false }).limit(LIMIT);
  if (error) throw new Error(`Initiative search failed: ${error.message}`);
  const initiatives = data ?? [];
  if (initiatives.length === 0) return { initiatives: [], meta: { returned: 0, total_matching: 0, truncated: false } };

  // Enrich with impact scores
  const [allSignals, customers] = await Promise.all([fetchSignals(orgId), fetchCustomers(orgId)]);
  const enriched = initiatives.map(init => {
    const linked = allSignals.filter((s: any) => s.linked_initiative_id === init.id);
    const impact = calculateImpact(linked, customers, hasRevenueScoring);
    return { ...init, impact: { score: impact.score, label: impact.label, totalArr: impact.totalArr, formattedArr: impact.formattedArr, volume: impact.volume, uniqueAccounts: impact.uniqueAccounts } };
  });
  const total = totalMatching ?? enriched.length;
  return { initiatives: enriched, meta: { returned: enriched.length, total_matching: total, truncated: total > LIMIT } };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Data Access — Customers
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchCustomers(orgId: string) {
  const { data, error } = await db().from('customers')
    .select('id,name,tier,arr,health_score,status,organization_id')
    .eq('organization_id', orgId).limit(500);
  if (error) throw new Error(`Failed to fetch customers: ${error.message}`);
  return data ?? [];
}

async function searchCustomers(orgId: string, query: string) {
  const { data, error } = await db().from('customers')
    .select('id,name,website,tier,arr,health_score,status,organization_id,created_at')
    .eq('organization_id', orgId).ilike('name', `%${query}%`).limit(10);
  if (error) throw new Error(`Customer search failed: ${error.message}`);
  return data ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Rank + Write Operations (unchanged from v16)
// ═══════════════════════════════════════════════════════════════════════════════

async function rankInitiatives(orgId: string, hasRevenueScoring: boolean) {
  const [initiatives, allSignals, customers] = await Promise.all([
    fetchInitiatives(orgId), fetchSignals(orgId), fetchCustomers(orgId)
  ]);
  const ranked = initiatives.map(init => {
    const linked = allSignals.filter((s: any) => s.linked_initiative_id === init.id);
    const impact = calculateImpact(linked, customers, hasRevenueScoring);
    return {
      id: init.id, display_id: init.display_id,
      title: init.title, brief: init.brief, state: init.state,
      target_outcome: init.target_outcome, health_metrics: init.health_metrics,
      impact: { score: impact.score, label: impact.label, rawScore: impact.rawScore, totalArr: impact.totalArr, formattedArr: impact.formattedArr, businessValue: impact.businessValue, leverage: impact.leverage, volume: impact.volume, uniqueAccounts: impact.uniqueAccounts, confirmationBonus: impact.confirmationBonus, gated: impact.gated },
      linked_signals: linked.length,
    };
  });
  ranked.sort((a, b) => b.impact.score - a.impact.score);
  const unlinkedCount = allSignals.filter((s: any) => !s.linked_initiative_id).length;
  return { initiatives: ranked, total: ranked.length, unlinked_signals: unlinkedCount };
}

async function createSignal(orgId: string, userId: string, input: Record<string, unknown>) {
  if (!SIGNAL_TYPES.includes(input.type as string)) throw new Error(`Invalid type '${input.type}'. Must be one of: ${SIGNAL_TYPES.join(', ')}.`);
  if (!SIGNAL_CATEGORIES.includes(input.category as string)) throw new Error(`Invalid category '${input.category}'. Must be 'feature' or 'workflow'.`);
  if (!SIGNAL_SEVERITIES.includes(input.severity as string)) throw new Error(`Invalid severity '${input.severity}'. Must be Low, Medium, or High.`);
  const payload = {
    id: crypto.randomUUID(), summary: String(input.summary).trim(),
    description: input.description ? String(input.description).trim() : undefined,
    type: input.type, category: input.category, severity: input.severity,
    source: input.source ?? 'mcp', account_id: input.account_id,
    status: 'New', organization_id: orgId, created_by: userId,
    ingestion_source: 'mcp', raw_payload: { mcp_tool: 'create_signal', timestamp: new Date().toISOString() },
    created_at: new Date().toISOString(),
  };
  const { data, error } = await db().from('signals').insert([payload]).select('id,display_id').single();
  if (error) throw new Error(`Failed to create signal: ${error.message}`);
  return data;
}

async function batchCreateSignals(orgId: string, userId: string, signals: Record<string, unknown>[]) {
  if (!signals?.length) throw new Error('signals array must not be empty.');
  if (signals.length > 100) throw new Error('Maximum 100 signals per batch.');
  const payloads = signals.map(input => {
    if (!SIGNAL_TYPES.includes(input.type as string)) throw new Error(`Invalid type '${input.type}'.`);
    if (!SIGNAL_CATEGORIES.includes(input.category as string)) throw new Error(`Invalid category '${input.category}'.`);
    if (!SIGNAL_SEVERITIES.includes(input.severity as string)) throw new Error(`Invalid severity '${input.severity}'.`);
    return {
      id: crypto.randomUUID(), summary: String(input.summary).trim(),
      description: input.description ? String(input.description).trim() : undefined,
      type: input.type, category: input.category, severity: input.severity,
      source: input.source ?? 'mcp', account_id: input.account_id,
      status: 'New', organization_id: orgId, created_by: userId,
      ingestion_source: 'mcp', raw_payload: { mcp_tool: 'batch_create_signals', timestamp: new Date().toISOString() },
      created_at: new Date().toISOString(),
    };
  });
  const { data, error } = await db().from('signals').insert(payloads).select('id,display_id');
  if (error) throw new Error(`Batch signal creation failed: ${error.message}`);
  return { created: data?.length ?? 0, ids: (data ?? []).map((d: any) => ({ signal_id: d.id, display_id: d.display_id })) };
}

async function updateSignal(orgId: string, input: Record<string, unknown>) {
  if (!input.signal_id) throw new Error('signal_id is required.');
  if (input.type && !SIGNAL_TYPES.includes(input.type as string)) throw new Error(`Invalid type.`);
  if (input.severity && !SIGNAL_SEVERITIES.includes(input.severity as string)) throw new Error(`Invalid severity.`);
  const updates: Record<string, unknown> = {};
  if (input.account_id !== undefined) updates['account_id'] = input.account_id;
  if (input.severity) updates['severity'] = input.severity;
  if (input.type) updates['type'] = input.type;
  if (input.summary) updates['summary'] = String(input.summary).trim();
  if (input.description !== undefined) updates['description'] = input.description ? String(input.description).trim() : null;
  if (input.source) updates['source'] = input.source;
  if (!Object.keys(updates).length) throw new Error('No fields provided to update.');
  const { data, error } = await db().from('signals').update(updates).eq('id', input.signal_id as string).eq('organization_id', orgId).select('id').single();
  if (error || !data) throw new Error(`Failed to update signal '${input.signal_id}': ${error?.message ?? 'not found'}`);
  return { id: data.id };
}

async function createInitiative(orgId: string, userId: string, input: Record<string, unknown>) {
  if (!input.title || !String(input.title).trim()) throw new Error('title is required.');
  const id = crypto.randomUUID();
  const { data, error } = await db().from('initiatives').insert([{
    id, title: String(input.title).trim(), brief: input.brief ? String(input.brief).trim() : null,
    state: 'Triaged', organization_id: orgId, created_by: userId, created_at: new Date().toISOString(),
  }]).select('id,display_id').single();
  if (error) throw new Error(`Failed to create initiative: ${error.message}`);
  const signalIds = input.signal_ids as string[] | undefined;
  if (signalIds?.length) {
    const { error: linkError } = await db().from('signals').update({ linked_initiative_id: data.id, status: 'In Progress' }).in('id', signalIds).eq('organization_id', orgId);
    if (linkError) console.warn(`[Arcate MCP] create_initiative: partial signal link — ${linkError.message}`);
  }
  return { id: data.id, display_id: data.display_id, linked: signalIds?.length ?? 0 };
}

async function createCustomer(orgId: string, userId: string, input: Record<string, unknown>, role: string) {
  if (role !== 'owner') throw new Error('create_customer is restricted to Organization Owners.');
  const existing = await searchCustomers(orgId, String(input.name).substring(0, 5));
  const nameLower = String(input.name).toLowerCase();
  const dup = existing.find((c: any) => c.name.toLowerCase().includes(nameLower) || nameLower.includes(c.name.toLowerCase()));
  if (dup) throw new Error(`Potential duplicate: "${(dup as any).name}" (id: ${(dup as any).id}).`);
  const id = `cus_arc_${crypto.randomUUID().split('-')[0]}`;
  const { data, error } = await db().from('customers').insert([{ id, name: String(input.name).trim(), website: input.website, tier: input.tier ?? 'Standard', arr: input.arr ?? 0, organization_id: orgId, created_at: new Date().toISOString() }]).select('id').single();
  if (error) throw new Error(`Failed to create customer: ${error.message}`);
  return data;
}

async function linkSignalsToInitiative(orgId: string, signalIds: string[], initiativeId: string, reasoning: string) {
  const { data: init, error: initErr } = await db().from('initiatives').select('id').eq('id', initiativeId).eq('organization_id', orgId).single();
  if (initErr || !init) throw new Error(`Initiative '${initiativeId}' not found.`);
  const { data: updated, error } = await db().from('signals').update({ linked_initiative_id: initiativeId, status: 'In Progress' }).in('id', signalIds).eq('organization_id', orgId).select('id');
  if (error) throw new Error(`Failed to link signals: ${error.message}`);
  for (const sid of signalIds) {
    await db().from('signals').update({ raw_payload: { mcp_tool: 'link_to_initiative', reasoning, initiative_id: initiativeId } }).eq('id', sid).eq('organization_id', orgId);
  }
  return { updated: updated?.length ?? 0 };
}

async function enrichInitiative(orgId: string, input: Record<string, unknown>) {
  const { data: init, error: fetchErr } = await db().from('initiatives').select('id,health_metrics,target_outcome').eq('id', input.initiative_id as string).eq('organization_id', orgId).single();
  if (fetchErr || !init) throw new Error(`Initiative '${input.initiative_id}' not found.`);
  const newMetrics = (input.health_metrics ?? {}) as Record<string, unknown>;
  for (const [key, val] of Object.entries(newMetrics)) {
    if (typeof val === 'number') continue;
    if (typeof val === 'object' && val !== null && 'value' in (val as any) && typeof (val as any).value === 'number') continue;
    throw new Error(`Invalid health_metric value for "${key}".`);
  }
  const merged = { ...(init.health_metrics ?? {}), ...newMetrics };
  const updates: Record<string, unknown> = {};
  if (input.title) updates['title'] = String(input.title).trim();
  if (input.refined_hypothesis) updates['brief'] = input.refined_hypothesis;
  if (input.target_outcome) updates['target_outcome'] = input.target_outcome;
  if (Object.keys(newMetrics).length) updates['health_metrics'] = merged;
  if (input.start_date) updates['start_date'] = input.start_date;
  if (input.target_date) updates['due_date'] = input.target_date;
  if (!Object.keys(updates).length) throw new Error('No updates provided.');
  const { error } = await db().from('initiatives').update(updates).eq('id', input.initiative_id as string).eq('organization_id', orgId);
  if (error) throw new Error(`Failed to enrich: ${error.message}`);
  if ((input.additional_signal_ids as string[] | undefined)?.length) {
    await db().from('signals').update({ linked_initiative_id: input.initiative_id, status: 'In Progress' }).in('id', input.additional_signal_ids as string[]).eq('organization_id', orgId);
  }
  return { success: true };
}
const SEVERITY_WEIGHT: Record<string, number> = { 'High': 3, 'Medium': 2, 'Low': 1 };
const TIER_WEIGHTS: Record<string, number> = { 'Enterprise': 100, 'Scale': 30, 'Standard': 10, 'Startup': 3, 'Free': 1 };
const SIGNAL_TYPE_WEIGHTS: Record<string, number> = { 'deal-loss': 30, 'problem': 10, 'friction': 3, 'mention': 1 };

interface ImpactResult {
  score: number; rawScore: number; confirmationBonus: number; uniqueAccounts: number;
  formattedScore: string; label: string; formattedArr: string; totalArr: number;
  businessValue: number; leverage: number; weightedSignals: number; volume: number;
  icpWeight: number; gated: boolean;
}

function calculateImpact(signals: any[], customers: any[], hasRevenueScoring: boolean): ImpactResult {
  if (!signals || signals.length === 0) return { score: 0, rawScore: 0, confirmationBonus: 1, uniqueAccounts: 0, formattedScore: '0', label: 'Negligible', formattedArr: '$0', totalArr: 0, businessValue: 0, leverage: 0, weightedSignals: 0, volume: 0, icpWeight: 1, gated: !hasRevenueScoring };
  let totalArr = 0;
  const uniqueCustomers = new Set<string>();
  let maxIcpWeight = 0;
  signals.forEach((s: any) => { if (s.account_id) uniqueCustomers.add(s.account_id); });
  uniqueCustomers.forEach(custId => {
    const customer = customers.find((c: any) => c.id === custId);
    if (customer) { totalArr += (customer.arr || 0); const weight = TIER_WEIGHTS[customer.tier] || 10; if (weight > maxIcpWeight) maxIcpWeight = weight; }
  });
  if (maxIcpWeight === 0) maxIcpWeight = 1;
  const arrLog = totalArr > 0 ? Math.log10(totalArr + 1) : 0;
  const businessValue = arrLog * maxIcpWeight;
  let weightedSignalSum = 0;
  signals.forEach((s: any) => { const type = s.type?.toLowerCase() || ''; let weight = SIGNAL_TYPE_WEIGHTS['mention']; for (const [key, w] of Object.entries(SIGNAL_TYPE_WEIGHTS)) { if (type.includes(key)) { weight = w; break; } } weightedSignalSum += Math.sqrt(weight); });
  const K = 5; const volume = signals.length;
  const signalLeverage = weightedSignalSum / Math.sqrt(volume + K);
  const rawScore = businessValue * signalLeverage;
  const uniqueAccountCount = uniqueCustomers.size;
  const confirmationBonus = Math.min(2.50, 1.0 + 0.2 * Math.sqrt(Math.max(0, uniqueAccountCount - 1)));
  let simpleTotalSeverity = 0;
  signals.forEach((s: any) => { simpleTotalSeverity += SEVERITY_WEIGHT[s.severity] || 1; });
  const simpleAvg = simpleTotalSeverity / Math.max(1, signals.length);
  const simpleScore = Math.round((simpleAvg / 3) * 100);
  let finalScore: number, label: string;
  if (hasRevenueScoring) {
    finalScore = Math.round(rawScore * confirmationBonus);
    if (finalScore >= 10000) label = 'High Leverage'; else if (finalScore >= 1000) label = 'Medium Leverage'; else if (finalScore >= 100) label = 'Low Confidence'; else label = 'Negligible';
    const isHighEvidence = volume >= 30 && uniqueAccountCount >= 10;
    if (totalArr > 100000 && signalLeverage < 15.0 && !isHighEvidence) { label = 'High Risk'; finalScore = Math.round(finalScore * 0.4); }
  } else {
    finalScore = simpleScore;
    if (simpleAvg >= 2.5) label = 'High Leverage'; else if (simpleAvg >= 1.5) label = 'Medium Leverage'; else label = 'Low Confidence';
  }
  const formatScore = (s: number) => { if (!s || s <= 0) return '0'; if (s >= 10000) return `${Math.round(s / 1000)}K`; if (s >= 1000) return `${(s / 1000).toFixed(1)}K`; return String(Math.round(s)); };
  return { score: finalScore, rawScore: Math.round(rawScore), confirmationBonus: parseFloat(confirmationBonus.toFixed(3)), uniqueAccounts: uniqueAccountCount, formattedScore: formatScore(finalScore), label, formattedArr: `$${totalArr.toLocaleString('en-US')}`, totalArr, businessValue: parseFloat(businessValue.toFixed(2)), leverage: parseFloat(signalLeverage.toFixed(4)), weightedSignals: parseFloat(weightedSignalSum.toFixed(4)), volume, icpWeight: maxIcpWeight, gated: !hasRevenueScoring };
}

const TOOLS = [
  { name: 'search_signals', description: 'Search signals by keyword and optional filters. Returns lean results (no description) with truncation metadata. Use get_signal for full detail.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string', enum: ['mention','friction','problem','deal-loss'] }, severity: { type: 'string', enum: ['Low','Medium','High'] }, unlinked_only: { type: 'boolean' } }, required: ['query'] } },
  { name: 'get_signal', description: 'Fetch full detail for a single signal by ID, including description and raw_payload. Use after search_signals to drill into a specific signal.', inputSchema: { type: 'object', properties: { signal_id: { type: 'string' } }, required: ['signal_id'] } },
  { name: 'search_customers', description: 'Look up customer accounts by name. Always call before create_signal.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'search_initiatives', description: 'Search roadmap initiatives by keyword. Returns impact scores.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'rank_initiatives', description: 'Rank all initiatives by impact score (Fermi Leverage Model). Returns initiatives sorted by score with full impact breakdown, plus count of unlinked signals in the triage queue. Use this to answer "what should we build next?"', inputSchema: { type: 'object', properties: { }, required: [] } },
  { name: 'create_initiative', description: 'Create a new roadmap initiative. Use search_initiatives first to avoid duplicates. Optionally supply signal_ids to link them atomically on creation.', inputSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 120 }, brief: { type: 'string' }, signal_ids: { type: 'array', items: { type: 'string' } } }, required: ['title'] } },
  { name: 'create_signal', description: 'Ingest a single customer feedback signal. For multiple signals, prefer batch_create_signals.', inputSchema: { type: 'object', properties: { summary: { type: 'string', maxLength: 200 }, description: { type: 'string' }, type: { type: 'string', enum: ['mention','friction','problem','deal-loss'] }, category: { type: 'string', enum: ['feature','workflow'] }, severity: { type: 'string', enum: ['Low','Medium','High'] }, source: { type: 'string', enum: ['Slack','Intercom','E-Mail','Support ticket','Sales call','User interview'] }, account_id: { type: 'string' } }, required: ['summary','type','category','severity'] } },
  { name: 'batch_create_signals', description: 'Ingest multiple feedback signals in one call. Accepts up to 100 signals as an array — USE THIS instead of calling create_signal in a loop. All tagged ingestion_source: mcp.', inputSchema: { type: 'object', properties: { signals: { type: 'array', maxItems: 100, items: { type: 'object', properties: { summary: { type: 'string', maxLength: 200 }, description: { type: 'string' }, type: { type: 'string', enum: ['mention','friction','problem','deal-loss'] }, category: { type: 'string', enum: ['feature','workflow'] }, severity: { type: 'string', enum: ['Low','Medium','High'] }, source: { type: 'string', enum: ['Slack','Intercom','E-Mail','Support ticket','Sales call','User interview'] }, account_id: { type: 'string' } }, required: ['summary','type','category','severity'] } } }, required: ['signals'] } },
  { name: 'create_customer', description: 'Add a new customer. RESTRICTED to Owners. Always search_customers first.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, website: { type: 'string' }, tier: { type: 'string', enum: ['Free','Standard','Premium','Enterprise'] }, arr: { type: 'number' } }, required: ['name'] } },
  { name: 'link_to_initiative', description: 'Connect signals to a roadmap initiative with reasoning.', inputSchema: { type: 'object', properties: { signal_ids: { type: 'array', items: { type: 'string' } }, initiative_id: { type: 'string' }, reasoning: { type: 'string' } }, required: ['signal_ids','initiative_id','reasoning'] } },
  { name: 'enrich_initiative', description: 'Strengthen an initiative with hypothesis, metrics, and linked signals. Also supports renaming the initiative title.', inputSchema: { type: 'object', properties: { initiative_id: { type: 'string' }, title: { type: 'string', maxLength: 120 }, refined_hypothesis: { type: 'string' }, target_outcome: { type: 'object', properties: { target_description: { type: 'string' }, metric: { type: 'string' }, validation_window_days: { type: 'number' } } }, health_metrics: { type: 'object', description: 'Key-value pairs where each value MUST be numeric.' }, additional_signal_ids: { type: 'array', items: { type: 'string' } }, start_date: { type: 'string' }, target_date: { type: 'string' } }, required: ['initiative_id'] } },
  { name: 'update_signal', description: 'Update one or more fields on an existing signal. Use to correct ingestion errors (wrong account_id, severity, type) without deleting and recreating. Supply only the fields to change.', inputSchema: { type: 'object', properties: { signal_id: { type: 'string' }, account_id: { type: 'string' }, severity: { type: 'string', enum: ['Low','Medium','High'] }, type: { type: 'string', enum: ['mention','friction','problem','deal-loss'] }, summary: { type: 'string', maxLength: 200 }, description: { type: 'string' }, source: { type: 'string', enum: ['Slack','Intercom','E-Mail','Support ticket','Sales call','User interview'] } }, required: ['signal_id'] } },
];

const PROMPTS = [
  { name: 'arcate:hello', description: 'Welcome — get an overview of your Arcate workspace and all available commands.' },
  { name: 'arcate:ingest', description: 'Log customer feedback from a call or interview into Arcate as a structured signal.', arguments: [{ name: 'context', description: 'Raw notes to ingest (optional)', required: false }] },
  { name: 'arcate:triage', description: 'Surface unlinked signals with no roadmap initiative yet.' },
  { name: 'arcate:enrich', description: 'Strengthen a roadmap initiative with hypothesis, metrics, and signal evidence.', arguments: [{ name: 'initiative', description: 'Initiative keyword to search for (optional)', required: false }] },
  { name: 'arcate:rank', description: 'Rank all initiatives by impact score and recommend what to build next.' },
];

function getPrompt(name: string, args?: Record<string, string>) {
  if (name === 'arcate:hello') {
    return { description: 'Arcate workspace welcome.', messages: [
      { role: 'user', content: { type: 'text', text: 'Hello Arcate. Introduce yourself, summarise what you have access to, and list guided commands.' } },
      { role: 'assistant', content: { type: 'text', text: ['👋 **Welcome to Arcate MCP.**','','I have direct access to your product discovery workspace.','','**📚 Your Data (summaries)**','- `arcate://signals` — Signal Inbox Summary (counts, severity breakdown, last 10 signals)','- `arcate://initiatives` — Roadmap Summary (counts, state breakdown, top 5 by evidence)','','**🔍 Read**','- `search_signals` — Lean results with truncation info','- `get_signal` — Full detail for a specific signal','- `search_customers` · `search_initiatives`','- `rank_initiatives` — Rank all by Fermi impact score','','**📥 Ingest**','- `create_signal` · `batch_create_signals` (up to 100)','- `create_initiative` · `create_customer` (Owners only)','','**✏️ Edit**','- `update_signal` — Correct account, severity, type, or summary','','**✨ Enrich**','- `link_to_initiative` · `enrich_initiative` (hypothesis + metrics + dates)','','**🚀 Guided commands**','- `arcate:ingest` — Log feedback','- `arcate:triage` — Find unlinked signals','- `arcate:enrich` — Strengthen an initiative','- `arcate:rank` — What should we build next?','','What would you like to do first?'].join('\\n') } },
    ]};
  }
  if (name === 'arcate:ingest') { const ctx = args?.context ? `\n\nRaw notes:\n\n${args.context}` : ''; return { description: 'Guided signal ingestion.', messages: [{ role: 'user', content: { type: 'text', text: `Log customer feedback into Arcate. Steps:\n1. search_customers to resolve account_id.\n2. search_signals to check for duplicates.\n3. Use batch_create_signals for multiple, create_signal for single.\n4. Confirm IDs. Use update_signal to correct account_id if needed.${ctx}` } }] }; }
  if (name === 'arcate:triage') { return { description: 'Find unlinked signals.', messages: [{ role: 'user', content: { type: 'text', text: 'Triage my Arcate signal inbox. Call search_signals with unlinked_only: true and a broad query. Group by type and severity. Highlight High-severity signals and suggest which initiatives they might belong to. If a clear cluster emerges with no matching initiative, call create_initiative to create it, then link the signals.' } }] }; }
  if (name === 'arcate:enrich') { const focus = args?.initiative ? `Focus on: "${args.initiative}".` : 'Ask me which initiative to work on.'; return { description: 'Enrich a roadmap initiative.', messages: [{ role: 'user', content: { type: 'text', text: `Enrich a roadmap initiative. ${focus}\n\n1. search_initiatives for the target.\n2. search_signals for relevant unlinked signals.\n3. enrich_initiative with updated brief, title (if needed), and linked signals.\n4. Summarise evidence strength.` } }] }; }
  if (name === 'arcate:rank') { return { description: 'Rank initiatives by impact.', messages: [{ role: 'user', content: { type: 'text', text: 'Rank my roadmap initiatives by impact score. Call rank_initiatives to get the full ranking. For each initiative, explain:\n1. The impact score and label\n2. Revenue at risk (ARR) and how many accounts are affected\n3. Signal composition (types and volume)\n4. Whether the evidence is strong enough to commit resources\n\nAlso check for unlinked signals in the triage queue and suggest if any clusters could form new initiatives.' } }] }; }
  throw new Error(`Unknown prompt: '${name}'`);
}

async function dispatch(body: Record<string, unknown>, apiKey: string | null): Promise<unknown> {
  const { id, method, params } = body as { id: unknown; method: string; params: Record<string, unknown> };
  const p = params ?? {};
  if (method === 'initialize') return rpcOk(id, { protocolVersion: '2024-11-05', capabilities: { resources: {}, tools: {}, prompts: {} }, serverInfo: { name: 'arcate-mcp', version: '0.11.0' } });
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
    if (method === 'prompts/list') return rpcOk(id, { prompts: PROMPTS });
    if (method === 'prompts/get') { const pArgs = (p.arguments ?? {}) as Record<string, string>; return rpcOk(id, getPrompt(p.name as string, pArgs)); }
    return rpcErr(id, -32601, `Method not found: '${method}'`);
  } catch (err) { return rpcErr(id, -32000, err instanceof Error ? err.message : 'Internal error'); }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '*';
  const corsH = cors(origin);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsH });
  if (req.method === 'GET') return json({ name: 'Arcate MCP Server', version: '0.11.0', protocol: 'Model Context Protocol (JSON-RPC 2.0 over HTTP)', docs: 'https://arcate.io/arcate-mcp', tools: TOOLS.map(t => t.name), resources: ['arcate://signals', 'arcate://initiatives'], prompts: PROMPTS.map(p => p.name), configure: 'Add this URL to your MCP client config with Authorization: Bearer arc_...' }, 200, corsH);
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
