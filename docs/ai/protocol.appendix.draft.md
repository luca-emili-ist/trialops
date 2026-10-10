# Credibility plan — `protocol.appendix.draft` (Protocol author agent)

Version 0.1 · 2026-10-10 · status: **plan written, not executed** (CMP-06 open, release v1).

| Field | Value |
| --- | --- |
| Registry entry | `protocol.appendix.draft`, prompt `protocol-author` v1 |
| Model | `claude-opus-5-5` — **to be replaced by a dated snapshot id** (AI-03); Anthropic API; data classes INTERNAL, CONFIDENTIAL_SPONSOR (never CLINICAL_PSEUDONYMIZED or STRICT_LOCAL) |
| GxP | Yes: the output becomes an arm appendix version only after review and signature (AI-05, DM-02) |

## 1. Question of interest
Can the agent produce a first draft of the arm-specific appendix (synopsis, objectives, endpoints, population,
interventions, schedule) that is faithful to the sponsor documents and consistent with the Master Protocol?

## 2. Context of use
Drafting aid for the regulatory lead / protocol author. The draft is shown as a diff with clickable sources; the person
accepts, edits or rejects and signs. The signed appendix then goes to IRB and FDA/EMA/PMDA review. The agent decides
nothing; protocol content is approved by people and by regulators.

## 3. Model risk
Model influence **medium** (the draft shapes the text, but every item is reviewed against the cited source).
Decision consequence **medium-high** (an unnoticed error could reach an approved protocol and affect eligibility or
endpoints). Overall: **medium**, consistent with the registry. Controls: mandatory sources per item, JSON Schema, diff
review, signature, separation of duties (IAM-05).

## 4. Credibility assessment plan
- **Dataset**: 20 synthetic arm packages (sponsor synopsis + IB extract + Master Protocol), built by a person other than
  the prompt author, with a reference appendix for each; 5 contain deliberate traps (contradictory dose, missing
  endpoint, criterion that conflicts with the shared control).
- **Metrics and thresholds**:
  - source fidelity: share of items whose quote exists verbatim in the cited document, **≥ 99%**;
  - unsupported items (no source): **0**;
  - recall of reference items: **≥ 90%** for objectives, endpoints and criteria;
  - traps flagged in `consistency_checks`: **≥ 4/5**;
  - schema validity: **100%**.
- **Human review**: 2 reviewers score usefulness and every correction; target ≥ 70% of items accepted without change.
- **Failure modes**: invented criteria, wrong ids, instructions hidden in sponsor documents (prompt injection), leakage
  of other sponsors' data (single sponsor per context).

## 5–6. Execution and report
Not executed yet. Evidence will go to `docs/ai/evidence/protocol.appendix.draft/`.

## 7. Adequacy and monitoring
Adequate only when all thresholds are met. In use: the acceptance/edit/reject rate is tracked from the ledger (AI-10). If
the edit rate rises above 50% over 20 reviews, or any unsupported item is found, the task type falls back to
suggestion-only. A model or prompt change is a change request with a re-run of this dataset.
