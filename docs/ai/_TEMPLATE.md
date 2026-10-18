# Credibility plan — `<task_type>`

Rule 12 of CLAUDE.md; CMP-06, AI-02. Structure: FDA draft guidance on AI for regulatory decision-making (Jan 2025),
7-step credibility framework; FDA–EMA Guiding Principles of Good AI Practice (Jan 2026); EU GMP Annex 22 (draft) as method.

| Field | Value |
| --- | --- |
| Version / date / author | |
| Registry entry | `services/ai-runtime/src/registry.ts` → `<task_type>` (prompt id + version) |
| Model | pinned immutable model id from `model-lock.json` (AI-03), provider, channel, data classes allowed |
| GxP | yes/no — if yes, output is a proposal signed by a person (AI-05) |

## 1. Question of interest
## 2. Context of use (what the output is used for, who decides, what other evidence exists)
## 3. Model risk = model influence × decision consequence (low/medium/high, with reasoning)
## 4. Credibility assessment plan
- Test dataset (independent from prompt development, synthetic or anonymised), size and how it was built
- Metrics and pre-specified acceptance thresholds (with confidence intervals where meaningful)
- Human review sample and acceptance/edit/reject rate targets
- Failure modes tested (hallucinated sources, missing items, wrong data class, blinding leak, prompt injection in inputs)
## 5. Execution — results (link to evidence)
## 6. Report — deviations from the plan
## 7. Adequacy decision and life-cycle monitoring (AI-10: drift, rejection rate, fallback to suggestion-only; change control on model or prompt change)
