/**
 * Customer data access — fetch, search, create.
 */
import { db } from './db.ts';

export async function fetchCustomers(orgId: string) {
  const { data, error } = await db().from('customers')
    .select('id,name,tier,arr,health_score,status,organization_id')
    .eq('organization_id', orgId).limit(500);
  if (error) throw new Error(`Failed to fetch customers: ${error.message}`);
  return data ?? [];
}

export async function searchCustomers(orgId: string, query: string) {
  const { data, error } = await db().from('customers')
    .select('id,name,website,tier,arr,health_score,status,organization_id,created_at')
    .eq('organization_id', orgId).ilike('name', `%${query}%`).limit(10);
  if (error) throw new Error(`Customer search failed: ${error.message}`);
  return data ?? [];
}

export async function createCustomer(orgId: string, userId: string, input: Record<string, unknown>, role: string) {
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
