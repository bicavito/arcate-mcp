/**
 * Initiative data access — CRUD, search, ranking, linking, enriching.
 */
import { db } from './db.ts';
import { fetchSignals } from './signals.ts';
import { fetchCustomers } from './customers.ts';
import { calculateImpact } from './impact.ts';

export async function fetchInitiatives(orgId: string) {
  const { data, error } = await db().from('initiatives')
    .select('id,display_id,title,brief,state,target_outcome,health_metrics,start_date,due_date,organization_id,created_at')
    .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(100);
  if (error) throw new Error(`Failed to fetch initiatives: ${error.message}`);
  return data ?? [];
}

/** Resource handler — lean summary for orientation */
export async function fetchInitiativesSummary(orgId: string) {
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

export async function searchInitiatives(orgId: string, query: string, hasRevenueScoring: boolean) {
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

export async function rankInitiatives(orgId: string, hasRevenueScoring: boolean) {
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

export async function createInitiative(orgId: string, userId: string, input: Record<string, unknown>) {
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

export async function linkSignalsToInitiative(orgId: string, signalIds: string[], initiativeId: string, reasoning: string) {
  const { data: init, error: initErr } = await db().from('initiatives').select('id').eq('id', initiativeId).eq('organization_id', orgId).single();
  if (initErr || !init) throw new Error(`Initiative '${initiativeId}' not found.`);
  const { data: updated, error } = await db().from('signals').update({ linked_initiative_id: initiativeId, status: 'In Progress' }).in('id', signalIds).eq('organization_id', orgId).select('id');
  if (error) throw new Error(`Failed to link signals: ${error.message}`);
  for (const sid of signalIds) {
    await db().from('signals').update({ raw_payload: { mcp_tool: 'link_to_initiative', reasoning, initiative_id: initiativeId } }).eq('id', sid).eq('organization_id', orgId);
  }
  return { updated: updated?.length ?? 0 };
}

export async function enrichInitiative(orgId: string, input: Record<string, unknown>) {
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
