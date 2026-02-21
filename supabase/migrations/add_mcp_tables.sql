-- ============================================================================
-- Arcate MCP Connect — Database Migration
-- Apply via: Supabase Dashboard → SQL Editor, or supabase db push
-- ============================================================================

-- ─── 1. api_keys table ───────────────────────────────────────────────────────
-- Stores hashed API keys for MCP authentication.
-- Plaintext keys are NEVER stored — only SHA-256 hashes.

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_prefix    TEXT NOT NULL,                        -- 'arc_<org>_<8chars>' for UI display
  key_hash      TEXT NOT NULL UNIQUE,                 -- SHA-256(plaintext_key)
  label         TEXT,                                 -- e.g. 'Claude Desktop', 'Internal Agents'
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes        JSONB NOT NULL DEFAULT '["read", "write"]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,                          -- Soft delete (kept for audit)
  expires_at    TIMESTAMPTZ                           -- Optional 90-day expiry
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix     ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_org_active ON api_keys(organization_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_hash       ON api_keys(key_hash);

-- RLS: Only org members can see their own keys
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view their org keys"
  ON api_keys FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM users WHERE id = auth.uid()
    )
  );

CREATE POLICY "Members can insert keys for their org"
  ON api_keys FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM users WHERE id = auth.uid()
    )
  );

CREATE POLICY "Members can revoke keys in their org"
  ON api_keys FOR UPDATE
  USING (
    organization_id IN (
      SELECT organization_id FROM users WHERE id = auth.uid()
    )
  );


-- ─── 2. Extend signals table ──────────────────────────────────────────────────
-- Adds provenance tracking for MCP-ingested signals.

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS ingestion_source TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS raw_payload      JSONB;

-- Validate ingestion sources
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'signals_ingestion_source_check'
  ) THEN
    ALTER TABLE signals
      ADD CONSTRAINT signals_ingestion_source_check
      CHECK (ingestion_source IN ('web', 'mcp', 'intercom_sync', 'api', 'bulk_import'));
  END IF;
END $$;

-- Index for filtering AI-generated signals in the UI
CREATE INDEX IF NOT EXISTS idx_signals_mcp_source
  ON signals(ingestion_source)
  WHERE ingestion_source = 'mcp';


-- ─── 3. Extend organizations table ───────────────────────────────────────────
-- Ensure capabilities JSONB has use_mcp key for all orgs.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS mcp_access_enabled BOOLEAN NOT NULL DEFAULT false;

-- Backfill capabilities for existing orgs (safe merge, no overwrite)
UPDATE organizations
  SET capabilities = COALESCE(capabilities, '{}'::jsonb) ||
    '{"use_mcp": false, "revenue_scoring": false, "workspace_sharing": false}'::jsonb
  WHERE capabilities IS NULL OR NOT capabilities ? 'use_mcp';


-- ─── 4. MCP Rate Limit Tracking (optional) ───────────────────────────────────
-- Lightweight table to count requests per API key per minute.
-- Can be replaced with a Redis-based solution at scale.

CREATE TABLE IF NOT EXISTS mcp_rate_limit_log (
  id              BIGSERIAL PRIMARY KEY,
  api_key_id      UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_key_time
  ON mcp_rate_limit_log(api_key_id, requested_at);

-- RLS: org members can only see their own org's entries
ALTER TABLE mcp_rate_limit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view their org rate limit log"
  ON mcp_rate_limit_log FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM users WHERE id = auth.uid()
    )
  );

-- Block direct client inserts — MCP server writes via service role key (bypasses RLS)
CREATE POLICY "No direct inserts — service role only"
  ON mcp_rate_limit_log FOR INSERT
  WITH CHECK (false);

-- Auto-prune old records (keep only last 5 minutes)
-- Run this as a scheduled function or cron in Supabase
-- DELETE FROM mcp_rate_limit_log WHERE requested_at < now() - interval '5 minutes';
