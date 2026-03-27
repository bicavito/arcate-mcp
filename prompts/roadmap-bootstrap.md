# Roadmap Bootstrap Prompt

Use this prompt when you have a large number of existing signals (50+) and want to structure them into a prioritized roadmap in one session. Copy the prompt below and paste it into Claude Desktop (or any MCP-connected AI client) with your Arcate workspace connected.

---

## When to use this

- You've just imported signals from a past tool (Intercom, Zendesk, spreadsheet)
- You've accumulated 50+ unlinked signals and want to bootstrap your roadmap
- You're starting fresh and want AI to surface the highest-priority themes

For ongoing, incremental ingestion (logging signals after a single call or interview), use the `arcate:ingest` guided prompt instead.

---

## The Prompt

```
You are a senior product manager. Your task is to analyze my full signal corpus and build a structured, evidence-based roadmap in Arcate.

Follow these steps exactly:

---

STEP 1 — LOAD ALL SIGNALS
Read the full signal corpus using the arcate://signals resource. Do not search — load everything.

STEP 2 — CLUSTER BY THEME
Group signals into recurring themes. A theme is valid only if it:
- Has 3 or more distinct signals pointing to the same underlying need
- Spans at least 2 different signal types (e.g. friction + problem, or mention + deal-loss)

Identify 6–12 themes. Ignore one-offs and outliers for now.

For each theme, note:
- Theme name (short, action-oriented)
- Signal count
- Highest severity level present
- The strongest 1-sentence evidence quote from the signals

STEP 3 — RANK THEMES
Sort by: (High-severity signal count × 3) + (Medium × 1) + deal-loss count × 5.
List themes in ranked order before writing anything to Arcate.

STEP 4 — CREATE INITIATIVES (top 8 themes only)
For each of the top 8 themes:
1. Call search_initiatives to check for an existing initiative. Skip if one already exists.
2. Call create_initiative with:
   - title: short, action-oriented (e.g. "Usage-Based Prompt Volume Tiers")  
   - brief: 2-sentence hypothesis — what the problem is and what solving it would achieve
   - signal_ids: array of the 5–10 strongest signal IDs for this theme

STEP 5 — ENRICH EACH INITIATIVE
For each initiative just created, call enrich_initiative with:
   - refined_hypothesis: expand the brief into a full hypothesis (3–4 sentences)
   - target_outcome: { target_description: "...", metric: "churn|activation|retention|expansion", validation_window_days: 60|90|180 }
   - health_metrics: use numeric values only. Example: { "Retention Rate": 0, "Churn Rate": 0 }

STEP 6 — REPORT
Summarise what you created:
- Number of initiatives
- Total signals linked
- Top 3 initiatives by evidence strength
- Any signals with no clear home (for manual review)

Do NOT try to link every single signal. Focus on quality coverage of the top themes.
Do NOT create more than 12 initiatives. Be ruthless — consolidate instead of splitting.
```

---

## Tips for best results

- **Run this once** on import, then switch to `arcate:ingest` for ongoing signal logging
- If step 4 produces duplicates, ask Claude to merge rather than create a new one
- The `health_metrics` baseline should always be `0` — Claude will fill in targets as evidence accumulates
- After running, use `arcate:enrich` to deepen individual initiatives with additional signals over time
