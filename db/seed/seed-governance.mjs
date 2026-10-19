// Quality and privacy governance demo data (CMP-05, CMP-08, VAL-04): fictitious providers, agreements, ROPA, CtQ/RBQM and
// the supplier validation evidence of the L2 demo app. Shared by seed-demo.mjs and scripts/backfill-demo-governance.mjs,
// so the remote demo gets exactly the rows of the local seed. Synthetic only (DM-05). Runs inside the caller's transaction.
export async function seedGovernance(c, plat, org) {
  const insRow = async (table, row) => {
    const cols = Object.keys(row);
    return (await c.query(`insert into core.${table} (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')}) returning id`,
      cols.map(k => row[k]))).rows[0].id;
  };
  await c.query("select set_config('trialops.change_reason', 'synthetic demo seed: provider qualification and activation', true)");
  const sha = n => n.toString(16).padStart(2, '0').repeat(32);
  const providers = {};
  for (const [code, name, kind, cats, regions, orgKey] of [
    ['demo-db-hosting', 'Example Cloud Database (synthetic)', 'database', ['operational', 'sponsor_confidential', 'pseudonymised_clinical'], ['US'], null],
    ['demo-ai-provider', 'Example AI Model Provider (synthetic)', 'ai', ['sponsor_confidential', 'pseudonymised_clinical'], ['US'], null],
    ['ist-app-supplier', 'InSilicoTrials Technologies (app supplier)', 'app_supplier', ['operational', 'sponsor_confidential'], ['EU', 'US'], 'ist'],
  ]) {
    const id = await insRow('service_provider', { code, name, kind, org_id: orgKey ? org[orgKey] : null, data_categories: cats, processing_regions: regions, review_interval_months: 36,
      responsibilities: `Synthetic demo provider: ${kind} services delegated by the lead operator` });
    providers[code] = id;
    await insRow('provider_oversight_activity', { provider_id: id, kind: 'qualification', performed_on: '2026-09-15', outcome: 'satisfactory' });
    await c.query("update core.service_provider set status = 'qualified' where id = $1", [id]);
    await insRow('provider_agreement', { provider_id: id, kind: 'QUALITY_AGREEMENT', effective_from: '2026-09-20', expires_on: '2030-09-19',
      document_ref: `demo://agreements/${code}/quality`, document_sha256: sha(1), status: 'effective' });
    if (cats.includes('pseudonymised_clinical'))
      await insRow('provider_agreement', { provider_id: id, kind: 'BAA', data_categories: ['pseudonymised_clinical'], regions: ['US'], effective_from: '2026-09-20',
        expires_on: '2030-09-19', document_ref: `demo://agreements/${code}/baa`, document_sha256: sha(2), status: 'effective' });
    await c.query("update core.service_provider set status = 'active' where id = $1", [id]);
  }
  await insRow('platform_provider', { platform_id: plat, provider_id: providers['demo-db-hosting'], data_categories: ['operational', 'sponsor_confidential', 'pseudonymised_clinical'],
    purpose: 'Hosting of the platform database' });
  await insRow('platform_provider', { platform_id: plat, provider_id: providers['demo-ai-provider'], data_categories: ['sponsor_confidential', 'pseudonymised_clinical'],
    purpose: 'AI runtime: protocol author and onboarding planner agents' });
  const ropa = await insRow('ropa_entry', { code: 'ROPA-001', version: 1, title: 'Operation of adaptive platform trials (synthetic demo)',
    controller: 'Northfield Clinical Institute (fictitious)', purpose: 'Conduct and oversight of the platform trial: enrolment, safety, quality management',
    legal_basis_us: 'HIPAA research authorization / IRB waiver as applicable (synthetic)', data_subject_categories: ['trial participants', 'site staff'],
    data_categories: ['pseudonymised_clinical', 'operational'], recipients: ['demo-db-hosting', 'demo-ai-provider'], regions: ['US'],
    retention: '25 years after the end of the trial (EU CTR art. 58 default of the platform)', security_measures: 'Pseudonymised subject codes, RLS per platform/arm/site, MFA, audit trail, encryption in transit and at rest' });
  await c.query("update core.ropa_entry set status = 'approved' where id = $1", [ropa]);
  const ctqSafety = await insRow('ctq_factor', { platform_id: plat, code: 'CTQ-SAFETY', title: 'Timely expedited safety reporting', category: 'participant_protection',
    rationale: 'Late SUSAR/SAE reporting directly affects participant protection across all arms' });
  const ctqElig = await insRow('ctq_factor', { platform_id: plat, code: 'CTQ-ELIG', title: 'Eligibility of randomized participants', category: 'data_reliability',
    rationale: 'Ineligible participants bias the shared-control comparison' });
  const riskSae = await insRow('quality_risk', { platform_id: plat, ctq_factor_id: ctqSafety, code: 'RISK-SAE-LATE', description: 'SAE reported after the expedited deadline',
    likelihood: 2, impact: 5, detectability: 2, controls: 'Expedited clock on every SAE (M07-01), daily safety task review', owner_role: 'safety_physician' });
  await insRow('quality_risk', { platform_id: plat, ctq_factor_id: ctqElig, code: 'RISK-ELIG', description: 'Participant randomized without meeting an eligibility criterion',
    likelihood: 2, impact: 4, detectability: 3, controls: 'Eligibility checklist at screening, CRA source data review', owner_role: 'ctm' });
  await insRow('quality_tolerance_limit', { platform_id: plat, ctq_factor_id: ctqSafety, risk_id: riskSae, code: 'QTL-SAE-OVERDUE', kind: 'QTL', metric: 'sae.open_overdue',
    description: 'Open serious adverse events past their expedited reporting deadline', unit: 'count', upper_limit: 0 });
  await insRow('quality_tolerance_limit', { platform_id: plat, ctq_factor_id: ctqElig, code: 'KRI-MAJOR-DEV', kind: 'KRI', metric: 'deviation.major_per_100_randomized',
    description: 'Major or critical protocol deviations per 100 randomized participants', unit: 'per 100 randomized', upper_limit: 25 });
  await insRow('quality_tolerance_limit', { platform_id: plat, ctq_factor_id: ctqElig, code: 'KRI-SCREEN-FAIL', kind: 'KRI', metric: 'subject.screen_failure_pct',
    description: 'Screen failures among screened participants', unit: '%', upper_limit: 40 });
  const vp = await insRow('app_validation_package', { app_id: 'ist.simulation-ta1', version: '1.4.0', gxp_class: 'L2', provider_id: providers['ist-app-supplier'],
    package_uri: 'https://sim.insilicotrials.example/vp/1.4.0.zip', package_sha256: sha(3),
    contents: ['URS', 'risk_assessment', 'test_plan', 'test_evidence', 'traceability', 'release_note'] });
  await c.query("update core.app_validation_package set status = 'accepted', review_note = 'Synthetic demo package: complete for an L2 app' where id = $1", [vp]);
  await insRow('app_contract_test_run', { app_id: 'ist.simulation-ta1', version: '1.4.0', suite: 'trialops-app-contract', suite_version: '1.0.0',
    passed: 42, failed: 0, evidence_uri: 'demo://contract-tests/ist.simulation-ta1/1.4.0', evidence_sha256: sha(4) });
}
