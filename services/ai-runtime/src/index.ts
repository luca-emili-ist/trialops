// TrialOps AI runtime (ARC-10): the only component allowed to call AI providers (AI-01).
export const AI_TASKS_PATH = '/api/ai/tasks';
export { createAiRuntime, providerFromEnv, AiRequestError, type AiRuntime } from './runtime.ts';
export { REGISTRY, MODEL, type TaskTypeDef } from './registry.ts';
export { replayProvider, recording, FIXTURES } from './providers/replay.ts';
export { DATA_CLASSES, type AiTaskRequest, type AiTaskResult, type DataClass, type Provider, type ProviderCall, type ProviderResult } from './types.ts';
export { runRegression, readModelLock, readDataset, type RegressionEvidence, type ModelLock } from './regression.ts';
