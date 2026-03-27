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
https://mcp.arcate.io
```
Header: `Authorization: Bearer arc_YOUR_KEY_HERE`

### 3. Restart your AI client and test
> "What are my top 5 unlinked customer signals from the last 30 days?"

---

## Resources (Read-Only)

| URI | Description |
|-----|-------------|
| `arcate://signals` | Unified Signal Inbox — all customer feedback |
| `arcate://initiatives` | Product Roadmap — active initiatives with evidence |

---

## Tools

### Read
| Tool | Description |
|------|-------------|
| `search_signals` | Search signals by keyword, type, or severity |
| `search_customers` | Look up customer accounts by name |
| `search_initiatives` | Find initiatives by keyword |

### Write
| Tool | Description |
|------|-------------|
| `create_initiative` | Create a new roadmap initiative (optionally link signals atomically) |
| `create_signal` | Ingest new customer feedback (tagged `ingestion_source: mcp`) |
| `create_customer` | Add a new customer profile (Owner only) |
| `link_to_initiative` | Connect signals to a roadmap initiative |
| `enrich_initiative` | Update hypothesis, metrics, and outcomes |
| `patch_signal` | Update fields on an existing signal |

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

**Triage a sales call:**
> "I just spoke with Acme Corp. They said bulk export times out on datasets over 100k rows. Log this as a signal."

**Review initiative evidence:**
> "Does our Mobile Revamp initiative have enough signal coverage to proceed to active?"

**Batch ingest:**
> "Here are notes from 3 customer calls this week. Create signals for each and link them to relevant initiatives."

---

## Security

- Keys are stored as SHA-256 hashes. The plaintext is shown only once and never stored.
- Every request is re-validated against `billing_status` and `use_mcp` capability.
- All queries are hard-scoped to your `organization_id`. Cross-tenant access is impossible.
- MCP-created signals are tagged with `ingestion_source: mcp` for audit filtering in the UI.

---

## Architecture

The server is deployed as a Supabase Edge Function implementing JSON-RPC 2.0 over HTTP (the MCP Streamable HTTP transport). A `GET` request to the server URL returns a human-readable info card — no MCP client needed to inspect it.

Source: `src/` — TypeScript reference implementation  
Deployment: Supabase Edge Functions (Deno)

---

## Database Setup

Apply the migration in `supabase/migrations/add_mcp_tables.sql` to bootstrap the `api_keys` table.
