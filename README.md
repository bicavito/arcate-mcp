# Arcate MCP Connect — Server

The official MCP server for [Arcate](https://arcate.io). Gives AI agents like Claude direct access to your product discovery workspace — reading signals, browsing your roadmap, and writing new feedback back in.

> **Requires an active Evidence subscription (€129/mo).** API keys are generated in `/settings/integrations` inside your Arcate workspace.

---

## Quick Start

### 1. Generate an API Key
Log into your Arcate workspace → **Settings → Integrations → Generate API Key**. Copy the key — it's shown only once.

### 2. Configure your MCP client

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "arcate": {
      "command": "npx",
      "args": ["-y", "@arcate/mcp-server"],
      "env": {
        "ARCATE_API_KEY": "arc_YOUR_KEY_HERE"
      }
    }
  }
}
```

**Cursor** → Settings → MCP → Add Server → Command:
```
npx -y @arcate/mcp-server
```

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
| `create_signal` | Ingest new customer feedback (tagged `ingestion_source: mcp`) |
| `create_customer` | Add a new customer profile (Owner only) |
| `link_to_initiative` | Connect signals to a roadmap initiative |
| `enrich_initiative` | Update hypothesis, metrics, and outcomes |

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
- Rate limit: 100 requests/min.

---

## Development

```bash
cd mcp/
npm install
cp .env.example .env   # fill in your values
npm run dev            # run locally with tsx
npm run build          # compile to dist/
```

Environment variables needed for development (see `.env.example`):
- `ARCATE_API_KEY` — your arc_ key
- `ARCATE_SUPABASE_URL` — your Supabase project URL
- `ARCATE_SUPABASE_SERVICE_KEY` — Supabase service role key (never expose client-side)

---

## Database Setup

Before running, apply the migration in `supabase/migrations/add_mcp_tables.sql` to your Supabase project.
