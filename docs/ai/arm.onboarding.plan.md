# Credibility plan — `arm.onboarding.plan` (Onboarding planner agent)

Version 0.1 · 2026-10-10 · status: **plan written, not executed** (CMP-06 open, release v1).

| Field | Value |
| --- | --- |
| Registry entry | `arm.onboarding.plan`, prompt `onboarding-planner` v1 |
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
- **Dataset**: 10 synthetic arms with a reference task list built by a platform operations manager.
- **Metrics**: recall of mandatory task types (IRB amendment, IND amendment, contract addendum, site activation per
  site, supply, eCRF set-up, training) **100%**; correct assignee role **≥ 90%**; `gxp_impact` correct on every task that
  produces a submission, approval or site green light **100%**; dependency graph acyclic **100%**.
- **Failure modes**: missing site tasks, GxP task marked non-GxP (the worst case: it would skip the review gate).

## 5–7. Execution, report, monitoring
Not executed yet. Monitoring: share of generated tasks cancelled or reassigned by people; above 30% the planner returns
to suggestion-only.
