# Change review — AI-07 tool registry and AI-08 signed Agent Decision Records

| Field | Value |
| --- | --- |
| Requirements | AI-07 "Tool registry AUTO/CONFIRM/BLOCK", AI-08 "Internal policy engine with signed decision records" (v1, GxP impact direct, risk high, assurance scripted; FDA-AI-HUMAN, P11-10g, P11-10e) |
| Branch | `v1-ai-governance` (from `main` 6c654b3) |
| Migration | `db/migrations/0025_ai_tool_registry_decisions.sql` (additive, idempotent) |
| Author | Claude Code (TrialOps development engine), 2026-10-19 |
| Human review | **Pending: Luca Emili** (required before merge, CLAUDE.md rule 9, risk high) |
| Open decision | Custody of the decision signing key in production (see §6) |

## 1. Design

**Tool registry (AI-07).** `core.ai_tool` holds one row per tool: effect (`read`, `proposal`, `operational_write`,
`gxp_write`), risk level, the agents allowed to use it, the roles that may confirm it, and the mode `AUTO` / `CONFIRM` /
`BLOCK`. Rows with `platform_id` null are the platform defaults and change only through migrations (change control); a
platform admin overrides the mode for one platform with `core.ai_tool_set_mode()` (person, `platform_admin`, reason). Every
insert or update writes an append-only version row in `core.ai_tool_version`; `core.ai_tool` itself is audited
(`attach_std 'gxp'`: a change needs a reason, no delete). A check constraint and the function refuse `AUTO` for a
`gxp_write`. A tool that is not in the registry resolves to nothing and is therefore `BLOCK`.

Initial registry: `protocol.appendix.propose` (Protocol author, proposal for human review and signature, AUTO),
`onboarding.tasks.create` (Onboarding planner, operational tasks assigned to roles, AUTO), `protocol.appendix.write`
(GxP write, BLOCK, no executor: GxP content is written only by people with a signature, AI-05).

**Policy engine (AI-08).** `packages/api/src/lib/policy-engine.ts`, version `trialops-policy/1`, deterministic and internal
(Deontos out of scope, decision 4). Inputs: the registry entry in force, the agent, the platform perimeter of the actor, the
existence of an executor, the AI-10 mode of the task type, and for a confirmation the person's decision. Rules in order,
first decisive wins:

| Rule | Decision |
| --- | --- |
| `AI07-UNREGISTERED` tool not registered | BLOCK |
| `AI08-PERIMETER` platform outside the actor's token | BLOCK |
| `AI07-MODE-BLOCK` tool registered as BLOCK (also at confirmation) | BLOCK |
| `AI07-AGENT-NOT-ALLOWED` agent not among the tool's agents | BLOCK |
| `AI08-NO-EXECUTOR` no executor in this release | BLOCK |
| `AI07-HUMAN-REJECTED` / `AI07-HUMAN-CONFIRMED` a person with a confirm role decided | BLOCK / ALLOW |
| `AI07-GXP-NEVER-AUTO` GxP write with AUTO (defence in depth; the database already refuses it) | REVIEW |
| `AI10-SUGGESTION-ONLY` task type in suggestion-only and the tool writes | REVIEW |
| `AI07-MODE-CONFIRM` | REVIEW |
| `AI07-MODE-AUTO` | ALLOW |

Agents (`packages/api/src/agents`) no longer write platform data themselves: they call `invokeTool()`, which evaluates,
writes the decision record, then runs the executor (`agents/tools.ts`) on ALLOW, creates a pending action
(`core.ai_pending_action`) on REVIEW, or does nothing on BLOCK (the task keeps the decision and the job ends with outcome
`blocked`). The AI runtime (`services/ai-runtime`) makes model calls only (AI-01) and invokes no tools. A pending action is
decided only by a person whose roles include one of the tool's confirm roles (`POST /v1/ai/pending-actions/{id}/decide`, or
`POST /v1/tasks/{id}/confirm-plan` for an onboarding plan); the engine evaluates again with the registry in force, so a
tool set to BLOCK meanwhile is refused even when confirmed; the tool then runs as that person.

**Agent Decision Record.** Every decision (agent call, confirmation, rejection) is a row of `core.agent_decision_record`
(0005, immutable; audited since 0015). New columns (0025): `seq`, `prev_record_sha256`, `signed_payload`,
`signature_status`, `key_id`, `tool_version_id`, `tool_mode`, `inputs_sha256`, `pending_action_id`, `ai_request_id`,
`model`, `prompt_id`, `prompt_version`, `actor_sub`, `actor_type`, `arm_id`. The engine asks the database for the next
sequence number, the previous record hash and the server UTC time (`core.agent_decision_head()`, transaction advisory
lock: one chain, no fork), builds the canonical JSON payload (sorted keys), hashes it (sha256), signs it with Ed25519 and
calls `core.agent_decision_append()`, which checks hash, sequence, link, time (±5 min of the server clock and not before
the previous record), actor (= caller), platform (= token), required fields, and the key id against the public key
(sha256 of the SPKI DER), then fills every column from the signed payload. Direct INSERT on the table was revoked; RLS
limits reading to the platform perimeter. Same scheme and code as the CMP-12 audit seal (`lib/audit-seal.ts`).

**Verification.** `GET /v1/ai/decisions/verify` (QA auditor, platform admin) and `node scripts/decision-verify.mjs verify`
(owner login; with `TRIALOPS_DECISION_PUBKEYS` the trusted keys come from outside the database) check contiguous sequence,
links, payload hashes, payload = row, and signatures. Unsigned records are reported as problems.

## 2. Key handling

`TRIALOPS_DECISION_SIGNING_KEY` (server environment only): Ed25519 private key, PKCS#8 PEM or its base64
(`node scripts/decision-verify.mjs keygen <file>`). Not set in development and tests: an ephemeral key per process,
marked `ephemeral` in `core.ai_decision_key`. Not set in production (`TRIALOPS_ENV=production`, `NODE_ENV=production`
or Netlify): records are still written, with `signature_status = 'unsigned'`, a warning at start-up, and the anomaly is
shown in `GET /v1/ai/monitoring` (`decision_records.anomalies`) and in the verifier. No key is committed or configured
by this change.

## 3. Threats considered

| Threat | Control |
| --- | --- |
| Agent calls a tool not foreseen (prompt injection, new code path) | Unregistered = BLOCK; agents act only through `invokeTool`; executors exist only for registered tools |
| GxP write without a person | `gxp_write` never AUTO (constraint + function + engine rule); `protocol.appendix.write` BLOCK and without executor; task FSM still requires review signature for GxP tasks (APP-TK-04) |
| Mode silently relaxed | Only a platform admin, with reason; versioned history; audit trail; defaults only by migration |
| Confirmation by the wrong person or by an agent/app | Person only, confirm role checked in API and database, reason required, state `pending` only once |
| Tool blocked between request and confirmation | Re-evaluation at confirmation with the registry in force |
| Forged or edited decision record | No INSERT grant; append function checks hash/chain/time/actor; immutable trigger; audit trail; Ed25519 signature verified with keys outside the database |
| Rogue key registered | Key id bound to the public key by the database; registration audited; the CLI verifier accepts only trusted keys from a file |
| Lost records on refusal | A BLOCK ends the job normally (commit), so the refusal record persists |
| Key missing in production | Records unsigned but written, flagged in monitoring and verification (never hidden) |
| Cross-platform reading | RLS on the new tables and on the decision records; the chain function only for reviewers, returns payloads without arguments |

Residual: the database cannot verify Ed25519 itself (as for CMP-12); a database owner could insert a self-consistent but
unsigned record (detected as unsigned) or rewrite the chain with a rogue key (detected by the CLI with trusted keys).

## 4. Test evidence (scripted)

- `db/tests/ai_governance.test.mjs` (5 tests): default registry and constraints; platform override versioned and audited;
  refusals (role, agent, reason, mode, GxP AUTO, unregistered, default, perimeter, direct writes); decision append checks
  (hash, chain, time, actor, platform, fields, key), immutability, RLS, reviewer-only chain; pending action creation and
  decision rules.
- `packages/api/test/ai_governance.test.ts` (11 tests): registry API; mode changes; CONFIRM flow end to end; rejection;
  BLOCK at request and at confirmation; AUTO with model/prompt/AI request in the record; AI-10 suggestion-only → REVIEW;
  unregistered / BLOCK / other agent's tool refused and recorded; rule table; chain verification and tamper detection;
  CLI verifier and keygen; unsigned mode in production.
- `db/tests/migrations_idempotent.test.mjs`: 0025 applied twice more without schema change.
- Existing AI-10, wizard and job tests unchanged and green (the planner's suggestion-only flow now goes through a pending
  action).

Results: `test-results.xml` of the gate run (`npm run verify`), traceability in `docs/traceability.md` and
`docs/compliance/compliance-matrix.md`.

## 5. Not in scope

Expiry of pending actions; a UI for the registry and the pending actions (API only); anchoring of decision records outside
the database (the CMP-12 audit seal covers the audit events of the records).

## 6. Decisions for Luca

1. Custody of `TRIALOPS_DECISION_SIGNING_KEY` in production (Netlify env, a KMS, or the same custody as the audit seal key)
   and where the trusted public keys are published for `TRIALOPS_DECISION_PUBKEYS`.
2. Confirm the initial modes (planner AUTO, Protocol author proposal AUTO, appendix write BLOCK) and the confirm roles.
