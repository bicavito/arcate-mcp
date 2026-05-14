/**
 * Shared database helpers and constants.
 * All modules import db() from here to avoid circular deps.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
export const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export const SIGNAL_TYPES = ['mention', 'friction', 'problem', 'deal-loss'];
export const SIGNAL_CATEGORIES = ['feature', 'workflow'];
export const SIGNAL_SEVERITIES = ['Low', 'Medium', 'High'];

export function db() { return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY); }
