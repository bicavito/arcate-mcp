# Arcate MCP Connect — Server

The official MCP server for [Arcate](https://arcate.io). Gives AI agents like Claude direct access to your product discovery workspace — reading signals, browsing your roadmap, and writing new feedback back in.

This is a **remote HTTP server** — no installation required. Configure a URL in your MCP client and connect instantly.

> **Requires an active Evidence subscription (€129/mo).** API keys are generated in `/settings/integrations` inside your Arcate workspace.

---

## Quick Start

### 1. Generate an API Key
Log in → **Settings → Integrations → Generate API Key**. Copy the key — shown only once.

### 2. Configure your MCP client

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "arcate": {
      "serverUrl": "https://eshuikffwhaxcvkzaewj.supabase.co/functions/v1/mcp-server",
      "headers": {
        "Authorization": "Bearer [YOUR API KEY]"
      }
    }
  }
}
```

**Cursor** → Settings → MCP → Add Server → Type: HTTP → URL:
```
https://eshuikffwhaxcvkzaewj.supabase.co/functions/v1/mcp-server
```
Header: `Authorization: Bearer arc_YOUR_KEY_HERE`

### 3. Restart your AI client and test
> "What are my top 5 unlinked customer signals?"

---

## Resources (Read-Only)

| URI | Description |
|-----|-------------|
| `arcate://signals` | Unified Signal Inbox — all customer feedback (latest 200) |
| `arcate://initiatives` | Product Roadmap — active initiatives with evidence (latest 100) |

---

## Tools

### Read
| Tool | Description |
|------|-------------|
| `search_signals` | Search signals by keyword, type, severity, or `unlinked_only` |
| `search_customers` | Look up customer accounts by name |
| `search_initiatives` | Find initiatives by keyword |

### Write
| Tool | Description |
|------|-------------|
| `create_initiative` | Create a new roadmap initiative (optionally link signals atomically) |
| `create_signal` | Ingest a single customer feedback signal |
| `batch_create_signals` | Ingest up to 100 signals in one call — prefer this over looping `create_signal` |
| `create_customer` | Add a new customer profile (Owner only) |
| `link_to_initiative` | Connect signals to a roadmap initiative |
| `enrich_initiative` | Update hypothesis, metrics, and outcome |
| `update_signal` | Correct fields on an existing signal (account_id, severity, type, summary) |

### `enrich_initiative` Schema

**`target_outcome`** — defines the expected outcome:
```json
{
  "target_description": "Reduce prompt-ceiling churn by 60% within 90 days",
  "metric": "churn",
  "validation_window_days": 90
}
```

**`health_metrics`** — key-value pairs where values **must be numeric**:
```json
{
  "Adoption Rate": 0,
  "Retention Rate": 85,
  "Time to Value": { "value": 14, "type": "duration" },
  "Expansion Rate": { "value": 1.5, "type": "ratio" }
}
```

Valid metric types: `percentage` (default for plain numbers), `ratio`, `currency`, `duration`, `number`.

> ⚠️ Passing string values for health metrics will return a validation error.

---

## Guided Prompts

| Prompt | Description |
|--------|-------------|
| `arcate:hello` | Welcome — get workspace overview and available commands |
| `arcate:ingest` | Log feedback from a call or interview |
| `arcate:triage` | Find unlinked signals with no initiative assigned |
| `arcate:enrich` | Strengthen a roadmap initiative with evidence |

---

## Example Prompts

**Bulk ingest from call notes:**
> "Here are notes from 8 customer calls this week. Use batch_create_signals to log them all."

**Triage unlinked signals:**
> "Find all High-severity unlinked signals and suggest which initiatives they belong to."

**Enrich an initiative:**
> "Does our API Access initiative have enough signal coverage to proceed to Active?"

**Correct a signal:**
> "The last signal I created has the wrong account_id. Update it to the Acme Corp ID."

---

## Tech Spec & Limitations

| Property | Value |
|----------|-------|
| Protocol | JSON-RPC 2.0 over HTTP (MCP Streamable HTTP transport) |
| Runtime | Supabase Edge Functions (Deno) |
| Auth | SHA-256 hashed API keys, prefix-indexed for fast lookup |
| Scope | Hard-scoped to `organization_id` — cross-tenant access impossible |
| `search_signals` limit | **500 results** per call |
| `search_initiatives` limit | **50 results** per call |
| `batch_create_signals` limit | **100 signals** per call — split larger batches |
| `arcate://signals` resource | Returns latest **200 signals** |
| `arcate://initiatives` resource | Returns latest **100 initiatives** |

---

## Security

- Keys are stored as SHA-256 hashes. The plaintext is shown only once and never stored.
- Every request is re-validated against `billing_status` and `use_mcp` capability.
- All queries are hard-scoped to your `organization_id`. Cross-tenant access is impossible.
- MCP-created signals are tagged with `ingestion_source: mcp` for audit filtering in the UI.

---

## Architecture

The server is deployed as a Supabase Edge Function implementing JSON-RPC 2.0 over HTTP (the MCP Streamable HTTP transport). A `GET` request to the server URL returns a human-readable info card — no MCP client needed to inspect it.

**Source:** `src/` — TypeScript reference implementation  
**Deployment:** Supabase Edge Functions (Deno)  
**Current version:** v0.9.0 (edge function v11)

---

## Database Setup

Apply the migration in `supabase/migrations/add_mcp_tables.sql` to bootstrap the `api_keys` table.
