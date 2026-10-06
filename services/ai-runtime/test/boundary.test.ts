// AI-01: no module or app calls a provider directly. The lint gate enforces it; these tests prove the gate works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const eslint = new ESLint();
async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map(m => m.ruleId ?? 'fatal');
}

test('[AI-01] a module importing a provider SDK fails the lint gate', async () => {
  const ids = await ruleIds("import Anthropic from '@anthropic-ai/sdk';\nexport default Anthropic;\n", 'packages/api/src/x.ts');
  assert.ok(ids.includes('no-restricted-imports'), ids.join(','));
});

test('[AI-01] a module calling a provider endpoint directly fails the lint gate', async () => {
  const ids = await ruleIds("export const r = fetch('https://api.anthropic.com/v1/messages');\n", 'apps/web/src/x.ts');
  assert.ok(ids.includes('no-restricted-syntax'), ids.join(','));
});

test('[AI-01] the AI runtime is the only place allowed to reach a provider', async () => {
  const ids = await ruleIds("export const u = 'https://api.anthropic.com/v1/messages';\n", 'services/ai-runtime/src/x.ts');
  assert.deepEqual(ids, []);
});
