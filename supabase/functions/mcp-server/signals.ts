/**
 * Signal data access — CRUD + search with truncation metadata.
 */
import { db, SIGNAL_TYPES, SIGNAL_CATEGORIES, SIGNAL_SEVERITIES } from './db.ts';

/** Lean select — no description field */
export const SIGNAL_LEAN = 'id,display_id,summary,type,category,severity,source,status,account_id,linked_initiative_id,organization_id,created_at,ingestion_source';
/** Full select — for get_signal detail and internal use */
export const SIGNAL_FULL = 'id,display_id,summary,description,type,category,severity,source,status,account_id,linked_initiative_id,organization_id,created_by,created_at,ingestion_source,raw_payload';

/** Internal use by rankInitiatives — full signals for impact calculation */
export async function fetchSignals(orgId: string) {
  const { data, error } = await db().from('signals')
    .select(SIGNAL_FULL)
    .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(500);
  if (error) throw new Error(`Failed to fetch signals: ${error.message}`);
  return data ?? [];
}

/** Resource handler — lean summary for orientation */
export async function fetchSignalsSummary(orgId: string) {
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
export async function getSignal(orgId: string, signalId: string) {
  const { data, error } = await db().from('signals')
    .select(SIGNAL_FULL)
    .eq('id', signalId).eq('organization_id', orgId).single();
  if (error || !data) throw new Error(`Signal '${signalId}' not found or access denied.`);
  return data;
}

/** Search — lean results + truncation metadata */
export async function searchSignals(orgId: string, query: string, filters?: { type?: string; severity?: string; linked_initiative_id?: string | null }) {
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

export async function createSignal(orgId: string, userId: string, input: Record<string, unknown>) {
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

export async function batchCreateSignals(orgId: string, userId: string, signals: Record<string, unknown>[]) {
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

export async function updateSignal(orgId: string, input: Record<string, unknown>) {
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
