// Contract of the AI runtime (AI-01): callers send an intent (task_type, data_class, input), never a model name.
export type DataClass = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL_SPONSOR' | 'CLINICAL_PSEUDONYMIZED' | 'STRICT_LOCAL';
export const DATA_CLASSES: DataClass[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL_SPONSOR', 'CLINICAL_PSEUDONYMIZED', 'STRICT_LOCAL'];

export interface AiTaskRequest {
  task_type: string;
  data_class: DataClass;
  input: Record<string, unknown>;
  platform_id?: string;
  arm_id?: string;
  task_id?: string;
}

export type Outcome = 'success' | 'validation_failed' | 'error' | 'timeout' | 'blocked';

export interface AiTaskResult {
  ai_request_id: string;
  outcome: Outcome;
  output: Record<string, unknown> | null;
  provider: string;
  model: string;
  error?: string;
}

/** What a provider receives: the rendered prompt, the pinned model and the JSON Schema of the expected output. */
export interface ProviderCall {
  task_type: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  max_tokens: number;
  system: string;
  user: string;
  output_schema: Record<string, unknown>;
  input_sha256: string;
}

export interface ProviderResult {
  output: unknown;
  model: string;                       // model id reported by the provider
  input_tokens: number;
  output_tokens: number;
  refusal?: string;                    // set when the provider declined (stop_reason refusal)
}

export interface Provider {
  name: string;                        // 'anthropic' | 'replay'
  /** Data classes this provider may receive (spec §9). */
  accepts: DataClass[];
  /** Nothing leaves the deployment (replay of recorded answers): no service provider is involved (NFR-06, CMP-08). */
  local?: boolean;
  call(c: ProviderCall): Promise<ProviderResult>;
}

/** Minimal database handle: the caller's transaction (RLS and audit apply to the ledger row). */
export interface LedgerDb {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
