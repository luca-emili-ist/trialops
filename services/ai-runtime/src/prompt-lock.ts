// Prompt lock (AI-02): the rendered system prompt and the output schema (the validator) of every task type are pinned
// per (prompt_id, prompt_version) by their SHA-256 in prompt-lock.json. Changing the prompt text or the schema without a
// new prompt_version, or a new version without change control (change request, approver, live regression evidence as for
// a model change, AI-03), fails test [AI-02] in services/ai-runtime/test/registry.test.ts and with it the CI gate.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, sha256 } from './canonical.ts';
import type { TaskTypeDef } from './registry.ts';

export const PROMPT_LOCK = join(dirname(fileURLToPath(import.meta.url)), '../prompt-lock.json');

export interface PromptVersionLock {
  version: number;
  system_sha256: string;
  output_schema_sha256: string;
  approved_on: string;
  authored_by: string[];               // people who wrote or tuned the prompt: they may not author or check its test dataset (CMP-07)
  approved_by: string | null;
  change_request: string | null;
  regression_evidence: string | null;
  reason: string;
}
export interface PromptLock { prompts: Record<string, { task_type: string; versions: PromptVersionLock[] }> }

export const readPromptLock = (file = PROMPT_LOCK): PromptLock => JSON.parse(readFileSync(file, 'utf8'));

/** Fingerprint of what the model is told: the system prompt (independent of the input) and the output schema. */
export function promptFingerprint(def: TaskTypeDef): { system_sha256: string; output_schema_sha256: string } {
  return { system_sha256: sha256(def.render({}).system), output_schema_sha256: sha256(canonical(def.output_schema)) };
}

/**
 * Problems of the prompt lock against the registry (empty = locked). `exists` checks a repo-relative evidence path.
 * Each registered prompt version must be locked with the current fingerprint; versions after the first need change control.
 */
export function promptLockProblems(registry: Record<string, TaskTypeDef>, lock: PromptLock, exists: (repoPath: string) => boolean,
  readEvidence: (repoPath: string) => { task_type?: string; mode?: string; passed?: boolean }): string[] {
  const out: string[] = [];
  for (const def of Object.values(registry)) {
    const entry = lock.prompts[def.prompt_id];
    const where = `${def.task_type} (prompt ${def.prompt_id} v${def.prompt_version})`;
    if (!entry) { out.push(`${where}: not in prompt-lock.json`); continue; }
    if (entry.task_type !== def.task_type) out.push(`${where}: prompt-lock.json gives it to ${entry.task_type}`);
    const latest = entry.versions.at(-1);
    if (!latest || latest.version !== def.prompt_version) {
      out.push(`${where}: the last locked version is ${latest?.version ?? 'none'}; a new prompt version needs its lock entry`);
      continue;
    }
    const fp = promptFingerprint(def);
    if (def.render({ probe: 'x' }).system !== def.render({}).system) out.push(`${where}: the system prompt depends on the input`);
    if (latest.system_sha256 !== fp.system_sha256) out.push(`${where}: system prompt changed without a new prompt_version (locked ${latest.system_sha256}, now ${fp.system_sha256})`);
    if (latest.output_schema_sha256 !== fp.output_schema_sha256) out.push(`${where}: output schema changed without a new prompt_version`);
    entry.versions.forEach((v, i) => {
      if (i > 0 && v.version <= entry.versions[i - 1]!.version) out.push(`${where}: versions must increase`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.approved_on)) out.push(`${where}: v${v.version} approved_on missing`);
      if (!Array.isArray(v.authored_by) || v.authored_by.length === 0) out.push(`${where}: v${v.version} authored_by missing`);
      if (i === 0) return;                                  // the first lock has nothing to regress against
      if (!v.change_request) out.push(`${where}: v${v.version} needs a change request`);
      if (!v.approved_by) out.push(`${where}: v${v.version} needs an approver`);
      if (!v.regression_evidence || !exists(v.regression_evidence)) { out.push(`${where}: v${v.version} needs regression evidence`); return; }
      const ev = readEvidence(v.regression_evidence);
      if (ev.task_type !== def.task_type || ev.mode !== 'live' || ev.passed !== true) {
        out.push(`${where}: v${v.version} regression evidence must be a passing live run of ${def.task_type}`);
      }
    });
  }
  return out;
}
