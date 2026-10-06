// Lint gate (part of `npm run verify`). Besides code quality it enforces AI-01:
// only services/ai-runtime may talk to an AI provider, everything else goes through POST /api/ai/tasks.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export const AI_PROVIDER_PACKAGES = ['@anthropic-ai/sdk', 'openai', '@google/genai', '@google/generative-ai',
  'cohere-ai', '@mistralai/mistralai', 'ollama'];
export const AI_PROVIDER_HOSTS = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|openrouter\.ai/;

const aiBoundary = {
  'no-restricted-imports': ['error', {
    paths: AI_PROVIDER_PACKAGES.map(name => ({ name, message: 'AI-01: call POST /api/ai/tasks (services/ai-runtime), never a provider directly.' })),
    patterns: [{ group: ['@anthropic-ai/*', '@mistralai/*'], message: 'AI-01: provider SDKs only inside services/ai-runtime.' }],
  }],
  'no-restricted-syntax': ['error', {
    selector: `Literal[value=${AI_PROVIDER_HOSTS}]`,
    message: 'AI-01: provider endpoints only inside services/ai-runtime.',
  }, {
    selector: `TemplateElement[value.raw=${AI_PROVIDER_HOSTS}]`,
    message: 'AI-01: provider endpoints only inside services/ai-runtime.',
  }],
};

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '.pgdata/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
    rules: { ...aiBoundary, '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  // the runtime itself, and its boundary tests that must spell the forbidden endpoints
  { files: ['services/ai-runtime/**'], rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': 'off' } },
);
