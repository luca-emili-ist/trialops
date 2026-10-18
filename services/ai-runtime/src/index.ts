// TrialOps AI runtime (ARC-10): the only component allowed to call AI providers (AI-01).
export const AI_TASKS_PATH = '/api/ai/tasks';
export { createAiRuntime, providerFromEnv, AiRequestError, type AiRuntime } from './runtime.ts';
export { REGISTRY, MODEL, type TaskTypeDef } from './registry.ts';
export { replayProvider, recording, FIXTURES } from './providers/replay.ts';
export { DATA_CLASSES, type AiTaskRequest, type AiTaskResult, type DataClass, type Provider, type ProviderCall, type ProviderResult } from './types.ts';
export { runRegression, readModelLock, readDataset, type RegressionEvidence, type ModelLock } from './regression.ts';
export { checkCitations, citationError, normaliseText, type CitationReport } from './citation.ts';
export { readPromptLock, promptFingerprint, PROMPT_LOCK, type PromptLock } from './prompt-lock.ts';
export { runCredibility, readCredibilityDataset, datasetSha256, provenanceProblems, type CredibilityEvidence, type DatasetManifest } from './credibility.ts';
export type { Threshold, MonitoringRule, MonitoringMetric, MonitoringPolicy, CitationPolicy } from './registry.ts';
export { default as DEMO_SPONSOR_DOCUMENTS } from '../fixtures/protocol.appendix.draft/demo-sponsor-documents.json' with { type: 'json' };
