// Replay provider (DEMO-03, tests): answers from recorded responses, so the demo works without network and tests never
// spend money. fixtures/<task_type>/<input_sha256>.json is an exact recording; default.json the demo answer.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_CLASSES, type Provider, type ProviderCall, type ProviderResult } from '../types.ts';
import appendixDraft from '../../fixtures/protocol.appendix.draft/default.json' with { type: 'json' };
import onboardingPlan from '../../fixtures/arm.onboarding.plan/default.json' with { type: 'json' };

/** Demo answers bundled with the code, so replay also works where the fixtures folder is not on disk (serverless). */
const DEFAULTS: Record<string, unknown> = { 'protocol.appendix.draft': appendixDraft, 'arm.onboarding.plan': onboardingPlan };

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

export function replayProvider(dir = FIXTURES): Provider {
  return {
    name: 'replay',
    accepts: DATA_CLASSES,                 // nothing leaves the perimeter
    local: true,
    async call(c: ProviderCall): Promise<ProviderResult> {
      const exact = join(dir, c.task_type, `${c.input_sha256}.json`);
      const output = existsSync(exact) ? JSON.parse(readFileSync(exact, 'utf8')) : structuredClone(DEFAULTS[c.task_type]);
      if (output === undefined) throw new Error(`no recorded response for ${c.task_type}`);
      return { output, model: c.model, input_tokens: 0, output_tokens: 0 };
    },
  };
}

/** Wraps a live provider and records each successful answer as an exact fixture (TRIALOPS_AI_RECORD=1). */
export function recording(live: Provider, dir = FIXTURES): Provider {
  return {
    ...live,
    local: false,                          // the live provider is called: its residency rules apply
    async call(c) {
      const r = await live.call(c);
      if (r.output !== null && !r.refusal) {
        const f = join(dir, c.task_type, `${c.input_sha256}.json`);
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify(r.output, null, 2) + '\n');
      }
      return r;
    },
  };
}
