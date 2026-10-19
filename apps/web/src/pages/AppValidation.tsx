// TRO-057 App validation (VAL-04, E6(R3) service providers, Annex 11 §3): for every app version of the catalogue, the
// activation gate (L2–L3 need the accepted supplier validation package and passing contract tests), the packages received
// with their review, and the contract test runs with their evidence hash (P5). Blocked gates first, with what is missing
// (P3, P6). Read view; packages and runs are recorded through the API by QA auditors and platform admins. English only.
import { PageHeader, Panel, DataTable, StatusPill, Loading, ErrorNote, EmptyState, DefinitionList } from '@trialops/shell';
import { useData } from '../session.tsx';
import { fmtDateTime, human, short } from '../format.ts';

export const APP_VALIDATION_ROLES = ['platform_admin', 'qa_auditor'] as const;

interface CatalogueApp { app_id: string; version: string; gxp_class: string; publisher: string; data_residency: string[]; available_in_region?: boolean }
interface Gate { required: boolean; package_id: string | null; package_status: string | null; supplier_code: string | null; supplier_status: string | null;
  contract_test_run_id: string | null; contract_test_result: string | null; ok: boolean; problems: string[] }
interface Pkg { id: string; package_uri: string; package_sha256: string; contents: string[]; status: string; review_note: string | null; reviewed_by: string | null;
  reviewed_at: string | null; received_by: string; received_at: string }
interface Run { id: string; suite: string; suite_version: string; passed: number; failed: number; skipped: number; result: string; evidence_uri: string;
  evidence_sha256: string; recorded_by: string; executed_at: string }
interface Validation { gate: Gate; packages: Pkg[]; contract_test_runs: Run[] }

export function AppValidation() {
  const cat = useData<{ items: CatalogueApp[]; region: string | null }>('/v1/apps/catalogue');
  if (cat.error) return <ErrorNote error={cat.error} />;
  if (!cat.data) return <Loading />;
  const apps = [...cat.data.items].sort((a, b) => b.gxp_class.localeCompare(a.gxp_class));   // L3, L2 first: the gated ones
  return (
    <>
      <PageHeader title="App validation" subtitle="An app that writes GxP data (class L2–L3) is activated only with the accepted validation package of its supplier and passing contract tests for that exact version. Lower classes need neither."
        facts={[['Apps in the catalogue', apps.length], ['Gated (L2–L3)', apps.filter(a => a.gxp_class >= 'L2').length], ['Region', cat.data.region ?? 'not pinned']]} />
      {apps.map(a => <AppGate key={`${a.app_id}@${a.version}`} app={a} />)}
    </>
  );
}

function AppGate({ app }: { app: CatalogueApp }) {
  const v = useData<Validation>(`/v1/apps/${encodeURIComponent(app.app_id)}/validation?version=${encodeURIComponent(app.version)}&gxp_class=${app.gxp_class}`);
  const title = `${app.app_id} ${app.version}`;
  if (v.error) return <Panel title={title}><ErrorNote error={v.error} /></Panel>;
  if (!v.data) return <Panel title={title}><Loading /></Panel>;
  const g = v.data.gate;
  const state = !g.required ? <span>Not required for class {app.gxp_class}</span> : g.ok ? <span>Open: can be activated</span>
    : <StatusPill tone="bad">Blocked</StatusPill>;
  return (
    <Panel title={title} meta={`${app.publisher} · class ${app.gxp_class} · data residency ${app.data_residency.join(', ')}${app.available_in_region === false ? ' · not offered in this region' : ''}`}>
      <DefinitionList items={[['Activation gate', state],
        ...(g.required && !g.ok ? [['Missing', g.problems.join('; ')] as [string, string]] : []),
        ['Supplier', g.supplier_code ? `${g.supplier_code} (${human(g.supplier_status)})` : '—'],
        ['Package', g.package_status ? human(g.package_status) : 'none received'], ['Contract tests', g.contract_test_result ? human(g.contract_test_result) : 'none run']]} />
      <div className="grid-2">
        <DataTable rows={v.data.packages} rowKey={p => p.id} label={`Validation packages of ${title}`} empty={<EmptyState title="No validation package received" />} columns={[
          { key: 'received', label: 'Package', wrap: true, render: p => <span className="cell-stack"><span>{p.package_uri}</span>
            <small className="t-mono">sha256 {short(p.package_sha256)} · {p.contents.length} documents</small></span> },
          { key: 'status', label: 'Review', wrap: true, render: p => <span className="cell-stack">{p.status === 'rejected' ? <StatusPill tone="bad">{human(p.status)}</StatusPill> : <span>{human(p.status)}</span>}
            <small>{p.reviewed_by ? `${p.reviewed_by} · ${fmtDateTime(p.reviewed_at)}` : `received by ${p.received_by} · ${fmtDateTime(p.received_at)}`}</small></span> },
        ]} />
        <DataTable rows={v.data.contract_test_runs} rowKey={r => r.id} label={`Contract test runs of ${title}`} empty={<EmptyState title="No contract test run" />} columns={[
          { key: 'suite', label: 'Suite', render: r => <span className="cell-stack"><span className="t-mono">{r.suite} {r.suite_version}</span><small>{fmtDateTime(r.executed_at)}</small></span>,
            sortValue: r => r.executed_at },
          { key: 'counts', label: 'Passed · failed', align: 'right', render: r => `${r.passed} · ${r.failed}` },
          { key: 'result', label: 'Result', render: r => r.result === 'pass' ? 'Pass' : <StatusPill tone="bad">{human(r.result)}</StatusPill> },
          { key: 'evidence', label: 'Evidence', render: r => <span className="t-mono" title={r.evidence_uri}>{short(r.evidence_sha256)}</span> },
        ]} />
      </div>
    </Panel>
  );
}
