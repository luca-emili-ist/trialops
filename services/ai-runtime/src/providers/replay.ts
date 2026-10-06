// Replay provider (DEMO-03, tests): answers from recorded responses, so the demo works without network and tests never
// spend money. fixtures/<task_type>/<input_sha256>.json is an exact recording; default.json the demo answer.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_CLASSES, type Provider, type ProviderCall, type ProviderResult } from '../types.ts';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

export function replayProvider(dir = FIXTURES): Provider {
  return {
    name: 'replay',
    accepts: DATA_CLASSES,                 // nothing leaves the perimeter
    async call(c: ProviderCall): Promise<ProviderResult> {
      const exact = join(dir, c.task_type, `${c.input_sha256}.json`);
      const file = existsSync(exact) ? exact : join(dir, c.task_type, 'default.json');
      if (!existsSync(file)) throw new Error(`no recorded response for ${c.task_type}`);
      return { output: JSON.parse(readFileSync(file, 'utf8')), model: c.model, input_tokens: 0, output_tokens: 0 };
    },
  };
}

/** Wraps a live provider and records each successful answer as an exact fixture (TRIALOPS_AI_RECORD=1). */
export function recording(live: Provider, dir = FIXTURES): Provider {
  return {
    ...live,
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
