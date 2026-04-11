# Arcate MCP Server

Your AI agent doesn't know who your customers are. It doesn't know which ones pay the most, which ones are churning, or which problems have been reported twelve times. Every session starts from scratch — and the output shows it.

Arcate fixes that. One config block, and your agent gets structured, revenue-weighted customer evidence it can query mid-conversation.

```
You: "What should we build next?"

Agent (via rank_initiatives):

  1. Remove the Prompt Ceiling for Agencies — Score: 21K (High Leverage)
     $487K ARR across 32 accounts, 47 signals
  2. Tell Users What To Do Next — Score: 1.0K (Medium Leverage)
     $332K ARR across 37 accounts, 56 signals
  3. Launch a Public REST API — Score: 3.3K (High Risk)
     $221K ARR but thin evidence — needs more validation
```

That's not a mockup. That's the actual output from a live workspace with real customer data, scored by impact.

---

## Setup (2 minutes)

### 1. Generate an API Key
Log in → **Settings → Integrations → Generate API Key**. Copy the key — shown only once.

### 2. Add to your MCP client

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "arcate": {
      "serverUrl": "https://mcp.arcate.io",
      "headers": {
        "Authorization": "Bearer arc_YOUR_KEY_HERE"
      }
    }
  }
}
```

**Cursor** → Settings → MCP → Add Server → Type: HTTP → URL: `https://mcp.arcate.io`  
Header: `Authorization: Bearer arc_YOUR_KEY_HERE`

### 3. Test it
> "What are my highest-impact initiatives? Which ones have enough evidence to commit resources?"

No installation. No npm. It's a remote HTTP server — configure the URL and go.

> **Requires an active Evidence subscription (€129/mo).** API keys are generated in `/settings/integrations` inside your Arcate workspace.

---

## What Your Agent Gets

### Resources (live data streams)

| URI | What it contains |
|-----|-----------------|
| `arcate://signals` | Every customer signal — feedback, friction, problems, deal-losses — tagged by source, severity, and linked account (latest 200) |
| `arcate://initiatives` | Your roadmap ranked by impact score — each initiative includes ARR at risk, signal volume, unique accounts, and evidence label (latest 100) |

### Read Tools

| Tool | What it does |
|------|-------------|
| `search_signals` | Find signals by keyword, type, severity, or `unlinked_only` |
| `search_customers` | Look up customer accounts by name — always call before creating signals |
| `search_initiatives` | Find initiatives by keyword — returns impact scores |
| `rank_initiatives` | Rank all initiatives by impact score and return the full breakdown — *the core tool* |

### Write Tools

| Tool | What it does |
|------|-------------|
| `create_signal` | Turn raw feedback into a structured, linked signal |
| `batch_create_signals` | Ingest up to 100 signals in one call |
| `create_initiative` | Create a new roadmap initiative (optionally link signals on creation) |
| `create_customer` | Add a customer profile with ARR and tier (Owner only) |
| `link_to_initiative` | Connect signals to an initiative with reasoning |
| `enrich_initiative` | Update hypothesis, metrics, dates, and outcome targets |
| `update_signal` | Correct fields on an existing signal |

---

## What the Agent Does With It

### "What should we build next?"

Your agent calls `rank_initiatives`. Every initiative comes back scored by a Fermi leverage model that weights:

- **Revenue at risk** — log-scaled ARR across all linked customer accounts
- **Signal strength** — type-weighted (deal-loss > problem > friction > mention), sqrt-dampened
- **Evidence breadth** — confirmation bonus for signals from multiple independent accounts
- **Risk detection** — high ARR with thin evidence gets flagged as "High Risk"

The labels tell you what to do:
- **High Leverage** — evidence supports committing resources
- **Medium Leverage** — promising, worth deeper investigation
- **High Risk** — significant revenue at stake but insufficient evidence — validate before building
- **Low Confidence** / **Negligible** — weak signal, deprioritize

### "Log this customer feedback"

After a call, paste your notes. The agent:
1. Resolves the customer via `search_customers`
2. Creates structured signals via `batch_create_signals`
3. Links them to relevant initiatives via `link_to_initiative`
4. The impact scores update automatically

### "Triage my inbox"

The agent calls `search_signals` with `unlinked_only: true`, groups by severity and type, and suggests which initiatives each signal belongs to. If a cluster has no matching initiative, it creates one.

---

## Guided Prompts

These appear as clickable flows in Claude's prompt picker and Cursor's slash commands:

| Prompt | What it does |
|--------|-------------|
| `arcate:hello` | Welcome — workspace overview and all available commands |
| `arcate:ingest` | Guided signal ingestion from raw call notes |
| `arcate:triage` | Surface and assign unlinked signals |
| `arcate:enrich` | Strengthen an initiative with evidence and metrics |
| `arcate:rank` | Rank initiatives by impact — what to build next |

---

## `enrich_initiative` Schema

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

## Bootstrapping Your Roadmap

Already have a large backlog of signals? Use the **Roadmap Bootstrap Prompt** to turn your entire signal corpus into a structured, prioritized roadmap in a single session — no manual triage required.

→ **[Roadmap Bootstrap Prompt](prompts/roadmap-bootstrap.md)**

---

## Security

- Keys are stored as SHA-256 hashes. The plaintext is shown only once and never stored.
- Every request is re-validated against `billing_status` and `use_mcp` capability.
- All queries are hard-scoped to your `organization_id`. Cross-tenant access is impossible.
- MCP-created signals are tagged with `ingestion_source: mcp` for audit filtering.

## Tech Spec

| Property | Value |
|----------|-------|
| Protocol | JSON-RPC 2.0 over HTTP (MCP Streamable HTTP transport) |
| Runtime | Supabase Edge Functions (Deno) |
| Auth | SHA-256 hashed API keys, prefix-indexed |
| Scope | Hard-scoped to `organization_id` — cross-tenant access impossible |
| `search_signals` limit | 500 results per call |
| `search_initiatives` limit | 50 results per call |
| `batch_create_signals` limit | 100 signals per call |
| `arcate://signals` resource | Latest 200 signals |
| `arcate://initiatives` resource | Latest 100 initiatives, ranked by impact |

## Architecture

Deployed as a Supabase Edge Function implementing JSON-RPC 2.0 over HTTP. A `GET` request to the server URL returns a human-readable info card — no MCP client needed to inspect it.

**Source:** [`src/`](src/) — TypeScript reference implementation  
**Deployment:** Supabase Edge Functions (Deno)  
**Current version:** v0.10.0

---

## Database Setup

Apply the migration in `supabase/migrations/add_mcp_tables.sql` to bootstrap the `api_keys` table.
