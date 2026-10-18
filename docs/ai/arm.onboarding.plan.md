# Credibility plan — `arm.onboarding.plan` (Onboarding planner agent)

Version 0.2 · 2026-10-18 · status: **plan written, not executed** (CMP-06 open, release v1).
0.2: thresholds and monitoring rules made machine-checkable against the registry (CMP-07); monitoring implemented (AI-10).

| Field | Value |
| --- | --- |
| Registry entry | `arm.onboarding.plan`, prompt `onboarding-planner` v1, locked in `services/ai-runtime/prompt-lock.json` (AI-02) |
| Model | `claude-opus-5-5`, pinned in `services/ai-runtime/model-lock.json` (AI-03); data classes INTERNAL, CONFIDENTIAL_SPONSOR |
| GxP | No for the plan itself. Tasks it marks `gxp_impact: true` go through review and signature when they are completed (APP-TK-04) |

## 1. Question of interest
Does the agent produce a complete and correctly assigned onboarding task plan for a new arm?

## 2. Context of use
Operational planning for the platform operations manager. Non-GxP tasks are created automatically; GxP records are
never produced by the plan itself.

## 3. Model risk
Model influence **low**, decision consequence **low**: a missing task is caught by the checklist and the arm lifecycle
gates (an arm cannot reach "ready for submission" without the regulatory and site steps). Overall **low**.

## 4. Credibility assessment plan
- **Dataset**: 10 synthetic arms with a reference task list built by a platform operations manager who did not write the
  prompt, checked by a second person, with provenance as for the protocol author (CMP-07).
- **Metrics**: recall of mandatory task types (IRB amendment, IND amendment, contract addendum, site activation per
  site, supply, eCRF set-up, training) **100%**; correct assignee role **≥ 90%**; `gxp_impact` correct on every task that
  produces a submission, approval or site green light **100%**; dependency graph acyclic **100%**.
- **Failure modes**: missing site tasks, GxP task marked non-GxP (the worst case: it would skip the review gate).

**Pre-specified thresholds** (machine-checked against `thresholds` in the registry by test [CMP-07]):

| Metric | Op | Value |
| --- | --- | --- |
| recall_mandatory_task_types | >= | 1 |
| assignee_role_correct | >= | 0.9 |
| gxp_impact_correct | >= | 1 |
| dependency_graph_acyclic | >= | 1 |

## 5. Execution — results
Not executed yet. The scorer of `scripts/ai-credibility.mjs` for this task type is still to be written (the protocol
author comes first). Evidence will go to `docs/ai/evidence/arm.onboarding.plan/`.

## 6. Report — deviations from the plan
None yet.

## 7. Adequacy decision and life-cycle monitoring
AI-10 monitoring (`GET /v1/ai/monitoring`, `POST /v1/ai/monitoring/evaluate`, state in `core.ai_task_type_state`)
measures the share of generated tasks that people cancelled or reassigned, over the last 50 generated tasks once at least
10 exist; above 30% the planner returns to suggestion-only: its plan is left as a proposal that a person confirms
(`POST /v1/tasks/{id}/confirm-plan`) instead of creating the tasks. Back to normal only by an explicit decision of a
platform admin with a reason. A model or prompt change is a change request with a re-run of the dataset (AI-03, AI-02).

| Monitoring rule (AI-10) | Max | Min sample |
| --- | --- | --- |
| generated_tasks_cancelled_or_reassigned_rate | 0.3 | 10 |

Window: 50
