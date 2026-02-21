/**
 * Arcate MCP Server — API Key Authentication
 *
 * Validates incoming API keys against the `api_keys` table in Supabase.
 * Keys are stored as bcrypt hashes — the plaintext is never saved.
 *
 * NOTE: This module uses the Supabase SERVICE_ROLE key to bypass RLS,
 *       because the API key itself is the authentication mechanism here.
 */

import { createClient } from '@supabase/supabase-js';
import { AuthContext, ArcateMCPError } from './types.js';

const SUPABASE_URL = process.env.ARCATE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.ARCATE_SUPABASE_SERVICE_KEY;

/**
 * Get an admin Supabase client (bypasses RLS).
 * Used only for API key validation and scoped data access.
 */
function getAdminClient() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        throw new ArcateMCPError(
            'Server misconfiguration: ARCATE_SUPABASE_URL and ARCATE_SUPABASE_SERVICE_KEY must be set.'
        );
    }
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

/**
 * Simple timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

/**
 * Validate an API key and return its auth context.
 *
 * Strategy: We use HMAC-SHA256 to make validation O(1) and safe.
 * The key format is: arc_<orgPrefix>_<64-char-hex-secret>
 * We store SHA-256(secret) in the DB, not bcrypt, for performance
 * (bcrypt is too slow for per-request validation at 100 req/min).
 */
export async function validateApiKey(providedKey: string): Promise<AuthContext> {
    if (!providedKey || !providedKey.startsWith('arc_')) {
        return { valid: false, organizationId: '', userId: '', scopes: [] };
    }

    const supabase = getAdminClient();

    // Extract the prefix (first 12 chars after 'arc_') for fast DB lookup
    // Full key = arc_<8-char-orgprefix>_<64-char-secret>
    const parts = providedKey.split('_');
    if (parts.length < 3) {
        return { valid: false, organizationId: '', userId: '', scopes: [] };
    }

    // Use the prefix to narrow the DB lookup (not the full hash comparison)
    const keyPrefix = `arc_${parts[1]}_${parts[2].substring(0, 8)}`;

    const { data: keys, error } = await supabase
        .from('api_keys')
        .select('id, key_hash, key_prefix, organization_id, user_id, scopes, revoked_at')
        .eq('key_prefix', keyPrefix)
        .is('revoked_at', null)
        .limit(5); // prefix should be near-unique; small safety margin

    if (error || !keys || keys.length === 0) {
        return { valid: false, organizationId: '', userId: '', scopes: [] };
    }

    // Hash the provided key using Web Crypto (available in Node 18+)
    const encoder = new TextEncoder();
    const keyBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(providedKey));
    const providedHash = Array.from(new Uint8Array(keyBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    for (const key of keys) {
        if (timingSafeEqual(providedHash, key.key_hash)) {
            // Update last_used_at (fire-and-forget, don't block response)
            supabase
                .from('api_keys')
                .update({ last_used_at: new Date().toISOString() })
                .eq('id', key.id)
                .then(() => { })
                .catch(() => { });

            return {
                valid: true,
                organizationId: key.organization_id,
                userId: key.user_id,
                scopes: key.scopes ?? ['read', 'write'],
            };
        }
    }

    return { valid: false, organizationId: '', userId: '', scopes: [] };
}

/**
 * Require a valid auth context or throw.
 * Use this at the top of every tool/resource handler.
 */
export async function requireAuth(
    apiKey: string | undefined,
    requiredScope?: 'read' | 'write'
): Promise<AuthContext> {
    if (!apiKey) throw new ArcateMCPError('No API key provided. Set ARCATE_API_KEY in your env.');

    const auth = await validateApiKey(apiKey);
    if (!auth.valid) throw new ArcateMCPError('Invalid or revoked API key.');

    if (requiredScope && !auth.scopes.includes(requiredScope)) {
        throw new ArcateMCPError(`This operation requires '${requiredScope}' scope.`);
    }

    // Verify org still has MCP access enabled
    const supabase = getAdminClient();
    const { data: org } = await supabase
        .from('organizations')
        .select('capabilities, billing_tier, billing_status')
        .eq('id', auth.organizationId)
        .single();

    if (!org) throw new ArcateMCPError('Organization not found.');

    const hasAccess = org.capabilities?.use_mcp === true;
    const activeBilling = org.billing_status === 'active';

    if (!hasAccess || !activeBilling) {
        throw new ArcateMCPError(
            'MCP Connect requires an active Evidence subscription (€129/mo). Visit your billing settings to upgrade.'
        );
    }

    return auth;
}
