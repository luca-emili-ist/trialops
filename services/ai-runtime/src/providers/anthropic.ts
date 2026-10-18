// Anthropic adapter. The only place in TrialOps that talks to a provider (AI-01, enforced by the lint gate).
// GxP routing is fixed (AI-03): the model is the one pinned in the task type registry, effort is fixed, the output is
// constrained by JSON Schema (AI-04). No automatic fallback to another model: a refusal is recorded as 'blocked'.
import Anthropic from '@anthropic-ai/sdk';
import type { Provider, ProviderCall, ProviderResult } from '../types.ts';

export function anthropicProvider(client: Anthropic = new Anthropic()): Provider {
  return {
    name: 'anthropic',
    // STRICT_LOCAL never leaves the perimeter; the others only with a qualified contract (spec §9, decision 5).
    accepts: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL_SPONSOR', 'CLINICAL_PSEUDONYMIZED'],
    async call(c: ProviderCall): Promise<ProviderResult> {
      // Streamed transport (CR-AI-0001): a long answer at high effort keeps bytes flowing, so an idle connection is not
      // dropped before the first token (seen at ~2 min without streaming). The request is the same; only the final
      // accumulated message is used.
      const stream = client.messages.stream({
        model: c.model,
        max_tokens: c.max_tokens,
        system: c.system,
        messages: [{ role: 'user', content: c.user }],
        output_config: { effort: c.effort, format: { type: 'json_schema', schema: c.output_schema } },
      });
      const res = await stream.finalMessage();
      const usage = { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
      if (res.stop_reason === 'refusal') {
        return { output: null, model: res.model, ...usage, refusal: res.stop_details?.category ?? 'refusal' };
      }
      if (res.stop_reason === 'max_tokens') throw new Error('output truncated at max_tokens');
      const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
      return { output: JSON.parse(text), model: res.model, ...usage };
    },
  };
}
