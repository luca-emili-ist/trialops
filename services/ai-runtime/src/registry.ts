// Task type registry (AI-02): every task type declares its intended use, risk, the exact model approved for it, a
// versioned prompt, the JSON Schema its output must satisfy and the data classes it may process.
import type { DataClass } from './types.ts';

export interface TaskTypeDef {
  task_type: string;
  intended_use: string;
  risk: 'low' | 'medium' | 'high';
  gxp: boolean;                        // output is a proposal that a person must sign (AI-05)
  model: string;                       // pinned, no automatic escalation (AI-03)
  effort: 'low' | 'medium' | 'high';
  max_tokens: number;
  prompt_id: string;
  prompt_version: number;
  data_classes: DataClass[];
  output_schema: Record<string, unknown>;
  render(input: Record<string, unknown>): { system: string; user: string };
}

export const MODEL = 'claude-opus-5-5';

const str = { type: 'string' } as const;
const obj = (properties: Record<string, unknown>) =>
  ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: unknown) => ({ type: 'array', items });

const criterion = obj({ id: str, text: str });
const appendixSchema = obj({
  sections: obj({
    synopsis: obj({ title: str, rationale: str, phase: { enum: ['phase1', 'phase1_2', 'phase2', 'phase2_3', 'phase3'] } }),
    objectives: arr(obj({ id: str, level: { enum: ['primary', 'secondary', 'exploratory'] }, text: str, endpoint_ids: arr(str) })),
    endpoints: arr(obj({ id: str, text: str, type: { enum: ['efficacy', 'safety', 'pharmacokinetic', 'pharmacodynamic', 'other'] }, timeframe: str })),
    population: obj({ description: str, inclusion: arr(criterion), exclusion: arr(criterion) }),
    interventions: arr(obj({ name: str, type: { enum: ['drug', 'biologic', 'placebo', 'device', 'other'] }, dose: str, route: str, frequency: str })),
    schedule: obj({ visits: arr(obj({ id: str, name: str, day: { type: 'integer' }, window_days: { type: 'integer' }, activities: arr(str) })) }),
  }),
  sources: arr(obj({ section: str, item_id: str, ref: str, quote: str })),
  consistency_checks: arr(obj({ check: str, result: { enum: ['pass', 'warning'] }, detail: str })),
});

const AREAS = ['regulatory', 'contracts', 'sites', 'supply', 'data_management', 'training'] as const;
const ROLES = ['platform_ops_manager', 'regulatory_lead', 'ctm', 'cra', 'data_manager', 'finance_controller', 'arm_sponsor_lead'] as const;
const onboardingSchema = obj({
  tasks: arr(obj({
    key: str, area: { enum: AREAS }, type: str, title: str, assignee_role: { enum: ROLES },
    due_in_days: { type: 'integer' }, gxp_impact: { type: 'boolean' }, site_number: str, depends_on: arr(str),
  })),
  checklist: arr(obj({ area: { enum: AREAS }, item: str })),
});

export const REGISTRY: Record<string, TaskTypeDef> = {
  'protocol.appendix.draft': {
    task_type: 'protocol.appendix.draft',
    intended_use: 'Protocol author agent: draft the arm appendix (ICH M11 / USDM sections) from the Master Protocol and sponsor documents. Proposal only; a person reviews the diff and signs.',
    risk: 'medium', gxp: true, model: MODEL, effort: 'medium', max_tokens: 16000,
    prompt_id: 'protocol-author', prompt_version: 1,
    data_classes: ['INTERNAL', 'CONFIDENTIAL_SPONSOR'],
    output_schema: appendixSchema,
    render: input => ({
      system: [
        'You draft the arm appendix of a platform trial Master Protocol. The appendix inherits everything from the Master',
        'Protocol and states only what is specific to the new arm: synopsis, objectives, endpoints, population (arm-specific',
        'inclusion/exclusion), interventions and schedule of activities. Use only facts present in the input documents.',
        'Every objective, endpoint, criterion and intervention must be supported by an entry in "sources" that names the',
        'document ref and quotes the supporting sentence. Where the input is silent, leave the list empty rather than invent.',
        'Ids: OBJ1.., EP1.., IN1.., EX1.., V1... Report in "consistency_checks" whether the arm keeps the shared-control',
        'population and visit schedule of the Master Protocol. This is a proposal for human review; it decides nothing.',
      ].join(' '),
      user: JSON.stringify(input),
    }),
  },
  'arm.onboarding.plan': {
    task_type: 'arm.onboarding.plan',
    intended_use: 'Onboarding planner agent: generate the onboarding task plan and checklist for a new arm (regulatory, contracts, sites, supply, data management). Non-GxP operational tasks are created automatically.',
    risk: 'low', gxp: false, model: MODEL, effort: 'low', max_tokens: 8000,
    prompt_id: 'onboarding-planner', prompt_version: 1,
    data_classes: ['INTERNAL', 'CONFIDENTIAL_SPONSOR'],
    output_schema: onboardingSchema,
    render: input => ({
      system: [
        'You plan the onboarding of a new arm into an existing platform trial. Produce the tasks needed to reach',
        '"ready for submission": arm addendum contract, IRB amendment package, FDA IND amendment, site activation for each',
        'listed site, investigational product supply, eCRF/data management set-up and training. Assign each task to one of',
        'the given roles, give a due date in days from today, and mark gxp_impact true for tasks that produce or change GxP',
        'records (submissions, approvals, site green light). Use site_number "" for tasks that are not site-specific.',
        'Keys are short unique slugs; depends_on lists keys. Keep it to what a platform operations manager would assign.',
      ].join(' '),
      user: JSON.stringify(input),
    }),
  },
};
