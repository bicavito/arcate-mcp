/**
 * API key validation and auth context resolution.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from './db.ts';

export interface AuthContext {
  organizationId: string;
  userId: string;
  scopes: string[];
  hasRevenueScoring: boolean;
}

export async function validateApiKey(key: string): Promise<AuthContext | null> {
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

export async function requireAuth(apiKey: string | null, scope?: 'read' | 'write'): Promise<AuthContext> {
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
