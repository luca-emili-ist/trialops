// TrialOps demo seed "demo-plat-001" — synthetic data only (DM-05, DEMO-04).
// Deterministic: same seed => same rows, same UUIDs (DEMO-01).
import pg from 'pg';
import { seedGovernance } from './seed-governance.mjs';
import { seedEdc } from './seed-edc.mjs';

const SEED = 20261006;
let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const uuid = () => { const h = [...Array(32)].map(() => Math.floor(rnd() * 16).toString(16)).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-${'89ab'[Math.floor(rnd()*4)]}${h.slice(17,20)}-${h.slice(20,32)}`; };
const day = (iso, plus = 0) => new Date(Date.parse(iso) + plus * 864e5).toISOString();

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const ins = async (table, row) => {
  const id = row.id || uuid(); const r = { id, ...row };
  const cols = Object.keys(r);
  await c.query(`insert into core.${table} (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')})`,
    cols.map(k => (r[k] !== null && typeof r[k] === 'object' && !(r[k] instanceof Date) ? JSON.stringify(r[k]) : r[k])));
  return id;
};

await c.query('begin');
const already = await c.query("select 1 from core.platform where code = 'PLAT-001'");
if (already.rowCount) { console.log('seed: PLAT-001 already present, nothing to do'); await c.query('rollback'); await c.end(); process.exit(0); }
await c.query("select set_config('trialops.actor','system:seed-demo-plat-001', true)");

// --- organizations (all fictitious)
const org = {};
for (const [k, name, type, small, country] of [
  ['lead', 'Northfield Clinical Institute', 'lead_operator', false, 'US'],
  ['ist', 'InSilicoTrials Technologies', 'technology_provider', true, 'IT'],
  ['arden', 'Arden Therapeutics', 'sponsor', true, 'US'],
  ['halv', 'Halvorsen Bio', 'sponsor', false, 'US'],
  ['merid', 'Meridian Pharma', 'sponsor', false, 'US'],
  ['cro', 'Keystone Clinical Research', 'cro', false, 'US'],
  ['irb', 'Unity Central IRB', 'committee', false, 'US'],
  ['fda', 'FDA (simulated)', 'regulator', false, 'US'],
]) org[k] = await ins('organization', { name, org_type: type, is_small_business: small, country });
const siteNames = ['Lakeside University Hospital', 'Bayview Medical Center', 'Granite State Neurology', 'Prairie Health System',
                   'Cedar Ridge Clinic', 'Riverside Academic Medical Center'];
const siteOrg = []; for (const n of siteNames) siteOrg.push(await ins('organization', { name: n, org_type: 'site', country: 'US' }));

// --- people
const person = {};
const people = [
  ['admin', 'lead', 'Dana Whitfield', 'platform_admin'], ['ops', 'lead', 'Marcus Ortega', 'platform_ops_manager'],
  ['ctm', 'lead', 'Priya Raman', 'ctm'], ['cra', 'cro', 'Tom Becker', 'cra'], ['reg', 'lead', 'Elena Rossi', 'regulatory_lead'],
  ['safety', 'lead', 'Dr. Samuel Okafor', 'safety_physician'], ['dm', 'lead', 'Lin Zhao', 'data_manager'],
  ['fin', 'lead', 'Grace Kim', 'finance_controller'], ['qa', 'lead', 'Olivia Grant', 'qa_auditor'],
  ['sac', 'lead', 'Prof. Henrik Lund', 'sac_member'],
  ['arden', 'arden', 'Nora Patel', 'arm_sponsor_lead'], ['halv', 'halv', 'James Holt', 'arm_sponsor_lead'],
  ['merid', 'merid', 'Sofia Mendes', 'arm_sponsor_lead'],
];
for (const [k, o, n, role] of people)
  person[k] = { id: await ins('person', { org_id: org[o], full_name: n, email: `${k}@demo.trialops.example`, idp_sub: `demo|${k}` }), role };
const pis = [];
for (let i = 0; i < 6; i++) pis.push(await ins('person', { org_id: siteOrg[i], full_name: `Dr. PI Site ${101 + i}`, email: `pi${101 + i}@demo.trialops.example`, idp_sub: `demo|pi${101 + i}` }));

// --- platform + protocol
const T0 = '2025-04-01T14:00:00Z';
const plat = await ins('platform', { code: 'PLAT-001', title: 'Platform trial in Disease X (synthetic demo)', therapeutic_area: 'Disease X (fictitious)',
  lead_operator_id: org.lead, status: 'active', data_region: 'US', created_at: T0 });
const sigMp = await ins('signature', { signer_sub: 'demo|admin', signer_name: 'Dana Whitfield', meaning: 'approval', target_table: 'master_protocol_version',
  target_id: '00000000-0000-4000-8000-000000000001', target_hash: 'seed', auth_method: 'reauth_mfa', signed_at: day(T0, 20) });
const mp = await ins('master_protocol_version', { platform_id: plat, version_label: '1.0', status: 'approved', approved_signature_id: sigMp,
  usdm: { study: { name: 'PLAT-001 Master Protocol', phases: ['phase1', 'phase2'], sharedControl: true } }, created_at: day(T0, 5) });

for (const role of Object.values(person))
  if (role.role !== 'arm_sponsor_lead')        // sponsors are scoped to their arm only (IAM-03)
    await ins('role_assignment', { person_id: role.id, role: role.role, platform_id: plat });

// --- arms (control + 3 investigational); arm 4 is created live during the demo
const armDefs = [
  ['CTRL', 'Shared control (placebo-matched)', null, 'control', null, null, 0],
  ['ARM-A', 'ARD-101 (first-in-human)', 'arden', 'drug', false, false, 30],
  ['ARM-B', 'HVB-220 monoclonal antibody', 'halv', 'biologic', true, false, 90],
  ['ARM-C', 'MRD-7 repurposed small molecule', 'merid', 'drug', true, true, 200],
];
const arm = {};
for (const [code, name, sp, type, prior, approved, offset] of armDefs) {
  arm[code] = await ins('arm', { platform_id: plat, code, name, sponsor_org_id: sp ? org[sp] : null, intervention_type: type,
    has_prior_human_data: prior, approved_any_indication: approved, status: 'active',
    current_stage: type === 'control' ? null : (offset < 100 ? 'efficacy' : 'dose_finding'), created_at: day(T0, offset) });
}
for (const [code, , sp, , , , offset] of armDefs.slice(1)) {
  const sig = await ins('signature', { signer_sub: 'demo|admin', signer_name: 'Dana Whitfield', meaning: 'approval', target_table: 'arm_appendix_version',
    target_id: arm[code], target_hash: 'seed', auth_method: 'reauth_mfa', signed_at: day(T0, offset + 10) });
  await ins('arm_appendix_version', { platform_id: plat, arm_id: arm[code], master_protocol_version_id: mp, version_label: '1.0', status: 'approved',
    approved_signature_id: sig, usdm: { arm: code }, created_at: day(T0, offset + 2) });
  await ins('control_sharing_rule', { platform_id: plat, control_arm_id: arm.CTRL, investigational_arm_id: arm[code], concurrency: 'concurrent_only',
    rationale: 'Same population and visit schedule' });
  await ins('role_assignment', { person_id: person[sp].id, role: 'arm_sponsor_lead', platform_id: plat, arm_id: arm[code] });
  // contract addendum, IRB, FDA per arm — the later the arm, the faster (platform learning)
  const speed = offset < 60 ? 1 : offset < 150 ? 0.6 : 0.3;
  await ins('contract', { platform_id: plat, arm_id: arm[code], counterparty_org_id: org[sp], kind: 'arm_addendum',
    negotiation_started_at: day(T0, offset + 1), executed_at: day(T0, offset + Math.round(28 * speed) + 2) });
  await ins('submission', { platform_id: plat, arm_id: arm[code], kind: 'irb_initial', authority: 'Unity Central IRB', status: 'closed',
    submitted_at: day(T0, offset + 5), outcome: 'approved', outcome_at: day(T0, offset + 5 + Math.round(20 * speed)) });
  await ins('submission', { platform_id: plat, arm_id: arm[code], kind: 'ind_amendment', authority: 'FDA', status: 'closed',
    submitted_at: day(T0, offset + 7), outcome: 'may_proceed', outcome_at: day(T0, offset + 37) });
}
await ins('submission', { platform_id: plat, kind: 'ind_initial', authority: 'FDA', status: 'closed', submitted_at: day(T0, 15), outcome: 'may_proceed', outcome_at: day(T0, 45) });
await ins('contract', { platform_id: plat, counterparty_org_id: org.ist, kind: 'vendor', executed_at: day(T0, 3) });

// --- sites + activations
const site = [];
for (let i = 0; i < 6; i++) {
  const sid = await ins('site', { platform_id: plat, org_id: siteOrg[i], site_number: String(101 + i), country: 'US',
    declared_capacity_per_month: [6, 5, 4, 4, 3, 4][i], status: 'active', created_at: day(T0, 10 + i * 12) });
  site.push(sid);
  await ins('role_assignment', { person_id: pis[i], role: 'site_pi', platform_id: plat, site_id: sid });
  await ins('contract', { platform_id: plat, site_id: sid, counterparty_org_id: siteOrg[i], kind: 'site_cta', executed_at: day(T0, 25 + i * 12) });
  for (const [code, , , , , , offset] of armDefs) {
    const start = Math.max(offset, 10 + i * 12);
    await ins('site_arm_activation', { platform_id: plat, arm_id: arm[code], site_id: sid, qualified_at: day(T0, start + 2),
      contract_executed_at: day(T0, start + 12), irb_approved_at: day(T0, start + 25), training_done_at: day(T0, start + 30),
      green_light_at: day(T0, start + 40) });
  }
}

// --- subjects: ~240, statuses consistent with time; randomization 1:1:1 + shared control
const subjects = [];
for (let i = 0; i < 6; i++) {
  const count = [57, 48, 44, 40, 35, 16][i];   // 240 subjects; site 106 underperforms
  for (let k = 0; k < count; k++) {
    const r = rnd();
    const status = r < 0.08 ? 'identified' : r < 0.15 ? 'prescreened' : r < 0.25 ? 'prescreen_failed' : r < 0.32 ? 'consented'
      : r < 0.40 ? 'screen_failed' : r < 0.55 ? 'randomized' : r < 0.85 ? 'on_treatment' : r < 0.95 ? 'completed' : 'withdrawn';
    const isRand = ['randomized', 'on_treatment', 'completed', 'withdrawn'].includes(status);
    const armCode = isRand ? pick(['CTRL', 'ARM-A', 'ARM-B', 'ARM-C', 'ARM-A', 'ARM-B']) : null;
    const minDay = isRand ? Math.max(armDefs.find(a => a[0] === armCode)[6], 10 + i * 12) + 45 : 60;
    const when = day(T0, int(minDay, 540));
    const id = await ins('subject', { platform_id: plat, site_id: site[i], subject_code: `${101 + i}-${String(k + 1).padStart(3, '0')}`,
      arm_id: armCode ? arm[armCode] : null, status, status_changed_at: when, created_at: day(when, -20) });
    subjects.push({ id, site: site[i], status });
  }
}

// --- adverse events (12, of which 2 serious)
const terms = ['Headache', 'Nausea', 'Fatigue', 'Dizziness', 'Injection site reaction', 'Rash', 'Insomnia', 'Back pain', 'Arthralgia', 'Diarrhoea'];
const treated = subjects.filter(x => ['on_treatment', 'completed', 'withdrawn'].includes(x.status));
for (let i = 0; i < 12; i++) {
  const sj = pick(treated); const serious = i < 2;
  await ins('adverse_event', { platform_id: plat, site_id: sj.site, subject_id: sj.id, term_verbatim: serious ? ['Hepatic enzyme increased', 'Syncope'][i] : pick(terms),
    serious, fatal_or_life_threatening: false, onset_date: day(T0, int(300, 540)).slice(0, 10), aware_at: day(T0, int(300, 545)), status: i < 9 ? 'closed' : 'open' });
}

// --- deviations (30), some proposed by the agent
const devCats = ['Visit out of window', 'Consent version not current', 'Missed lab sample', 'IP temperature excursion', 'Eligibility criterion not met'];
for (let i = 0; i < 30; i++) {
  const sj = pick(subjects); const bySite = site.indexOf(sj.site);
  await ins('deviation', { platform_id: plat, site_id: sj.site, subject_id: sj.id, category: pick(devCats),
    severity: rnd() < 0.8 ? 'minor' : 'major', detected_by: rnd() < 0.4 ? 'agent' : (rnd() < 0.5 ? 'rule' : 'human'),
    description: 'Synthetic deviation for demo', status: i < 24 ? 'closed' : (bySite === 5 ? 'proposed' : 'confirmed'), detected_at: day(T0, int(120, 545)) });
}

// --- documents (TMF)
const docs = [['platform', '01', 'Trial Management', 'Trial Master File Plan'], ['platform', '02', 'Central Trial Documents', 'Master Protocol v1.0'],
  ['platform', '03', 'Regulatory', 'IND cover letter'], ['platform', '04', 'IRB', 'Central IRB approval letter']];
for (const [lvl, zone, sec, title] of docs) await ins('document', { platform_id: plat, tmf_level: lvl, tmf_zone: zone, tmf_section: sec, tmf_artifact: title, title, status: 'approved', classified_by: 'human' });
for (const code of ['ARM-A', 'ARM-B', 'ARM-C'])
  for (const t of ['Arm appendix v1.0', 'Investigator Brochure', 'IRB approval (arm)', 'Arm addendum contract'])
    await ins('document', { platform_id: plat, arm_id: arm[code], tmf_level: 'arm', tmf_zone: '02', tmf_artifact: t, title: `${code} — ${t}`, status: 'approved', classified_by: rnd() < 0.5 ? 'agent' : 'human' });

// --- tasks in various states
const taskTypes = [['site.performance.review', 'Review enrollment shortfall at site 106', 'role', 'ctm', true],
  ['deviation.classify', 'Classify agent-proposed deviation', 'role', 'ctm', true],
  ['tmf.qc', 'QC agent-filed TMF documents (sample)', 'role', 'qa_auditor', true],
  ['access.review', 'Quarterly access review', 'role', 'platform_admin', false],
  ['simulation.scenario.review', 'Review updated enrollment forecast', 'role', 'platform_ops_manager', false]];
for (const [type, title, kind, who, gxp] of taskTypes)
  await ins('task', { platform_id: plat, site_id: type.startsWith('site') ? site[5] : null, type, title, assignee_kind: kind, assignee: who,
    gxp_impact: gxp, priority: type.startsWith('site') ? 'high' : 'normal', state: 'assigned', due_at: day('2026-10-06T00:00:00Z', 7) });

// --- time entries (for the human-hours metric)
for (let i = 0; i < 60; i++) await ins('time_entry', { platform_id: plat, arm_id: pick([arm['ARM-A'], arm['ARM-B'], arm['ARM-C'], null]),
  person_id: pick(Object.values(person)).id, activity: pick(['site activation', 'IRB package', 'contract review', 'data review', 'TMF QC']),
  work_date: day(T0, int(30, 545)).slice(0, 10), hours: int(1, 6) });

// --- app pending approval in the catalogue (demo step 4)
await ins('app_installation', { app_id: 'ist.simulation-ta1', version: '1.4.0', gxp_class: 'L2', platform_id: plat,
  manifest: { app_id: 'ist.simulation-ta1', version: '1.4.0', publisher: 'InSilicoTrials Technologies', data_residency: ['EU', 'US'], scopes: ['platform:read', 'arm:read', 'enrollment.metrics:read', 'simulation.results:write'],
              task_types: ['simulation.rerun', 'simulation.scenario.review'] } });

// --- site registry (M02-01): investigators, certifications, concurrent trials. Appended last so earlier UUIDs stay stable.
const specialties = ['Neurology', 'Internal medicine', 'Clinical pharmacology', 'Neurology', 'Family medicine', 'Neurology'];
for (let i = 0; i < 6; i++) {
  await ins('site_investigator', { platform_id: plat, site_id: site[i], person_id: pis[i], full_name: `Dr. PI Site ${101 + i}`,
    investigator_role: 'principal', specialty: specialties[i], gcp_training_valid_until: day('2026-10-06T00:00:00Z', int(-30, 700)).slice(0, 10) });
  for (let k = 0; k < int(1, 3); k++)
    await ins('site_investigator', { platform_id: plat, site_id: site[i], full_name: `Dr. Sub-I ${101 + i}-${k + 1}`, investigator_role: 'sub',
      specialty: pick(specialties), gcp_training_valid_until: day('2026-10-06T00:00:00Z', int(-60, 700)).slice(0, 10) });
  for (const kind of ['GCP inspection', 'CLIA lab', 'Pharmacy IP handling'])
    if (kind !== 'CLIA lab' || i !== 4)
      await ins('site_certification', { platform_id: plat, site_id: site[i], kind, issuer: kind === 'CLIA lab' ? 'CMS (simulated)' : 'Northfield QA',
        valid_until: day('2026-10-06T00:00:00Z', int(60, 900)).slice(0, 10) });
  for (let k = 0; k < [1, 2, 0, 1, 3, 2][i]; k++)
    await ins('site_concurrent_trial', { platform_id: plat, site_id: site[i], title: `Synthetic concurrent study ${101 + i}-${k + 1}`,
      registry_id: `NCT9${String(int(1000000, 9999999))}`, competes_for_population: i === 5 || rnd() < 0.3 });
}

// --- quality and privacy governance (CMP-05, CMP-08, VAL-04). Appended last so earlier UUIDs stay stable.
await seedGovernance(c, plat, org);

// --- native EDC (EDC-01..EDC-12): CRF library, visits, values and queries at site 101. Appended last.
await seedEdc(c);

await c.query('commit');
const counts = await c.query(`select (select count(*) from core.subject) subjects, (select count(*) from core.site) sites,
  (select count(*) from core.arm) arms, (select count(*) from core.audit_event) audit_events, (select count(*) from core.event_outbox) events`);
console.log('seed demo-plat-001 done:', counts.rows[0]);
await c.end();
