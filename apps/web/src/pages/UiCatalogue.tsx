// TRO-099 Design system catalogue: every base component in its states. Reference for anyone writing pages (docs/DESIGN.md).
import { useState } from 'react';
import { AppShell, PageHeader, Panel, Button, TextField, SelectField, Field, Textarea, StatusPill, KeyFigures, DataTable, MetricBar, Steps,
  DiffList, EmptyState, DefinitionList, SignDialog, ReasonDialog, Loading, ErrorNote, useToast } from '@trialops/shell';
import { PAGE_CODES } from '../pageCodes.ts';

const rows = [{ id: '101', name: 'Lakeside University Hospital', randomized: 34, status: 'active' }, { id: '106', name: 'Riverside Academic Medical Center', randomized: 7, status: 'on_hold' }];

export function UiCatalogue() {
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'sign' | 'reason'>(null);
  return (
    <AppShell brand="TrialOps" subtitle="Design system" pageCode={PAGE_CODES.uiCatalogue} banner="Synthetic data — demonstration environment"
      nav={[{ label: 'Components', href: '#/ui', active: true, group: 'Catalogue' }, { label: 'Back to the app', href: '#/', group: 'Catalogue' }]}>
      <PageHeader crumbs="Direction C · sober regulatory" title="Component catalogue" subtitle="Pages use only these components and the tokens in packages/shell/src/tokens.css."
        actions={<><Button variant="primary">Primary</Button><Button variant="sign">Sign</Button></>} />
      <Panel title="Buttons">
        <div className="row"><Button variant="sign">Sign and approve</Button><Button variant="primary">Start new arm</Button><Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button><Button variant="danger">Reject</Button><Button variant="primary" disabled>Disabled</Button></div>
      </Panel>
      <Panel title="Status">
        <div className="row"><StatusPill tone="ok">Final target met</StatusPill><StatusPill tone="warn">Interim target met</StatusPill><StatusPill tone="bad">Off target</StatusPill>
          <StatusPill tone="info">In progress</StatusPill><StatusPill tone="neutral">Draft</StatusPill></div>
      </Panel>
      <KeyFigures items={[{ label: 'Arms active', value: '3 + control' }, { label: 'Sites active', value: '6 of 6' }, { label: 'Randomized', value: 141, note: '240 identified' }]} />
      <div className="grid-2">
        <Panel title="Form fields" meta="Every GxP change asks for a reason; every signature for the password again.">
          <div className="form-grid">
            <TextField label="Arm code" defaultValue="ARM-D" hint="Capital letters, digits and dashes" />
            <TextField label="Version label" defaultValue="" error="Version label is required" />
            <SelectField label="Intervention type" options={[{ value: 'drug', label: 'drug' }, { value: 'biologic', label: 'biologic' }]} />
          </div>
          <Field label="Rationale"><Textarea aria-label="Rationale" defaultValue="MRD-12 showed target engagement in phase 1." /></Field>
        </Panel>
        <Panel title="Metric bar and steps">
          <DefinitionList items={[['Contract, ARM-A (30 d)', <MetricBar value={30} interim={30} final={7} />], ['IRB, ARM-C (6 d)', <MetricBar value={6} interim={21} final={7} />], ['No data', <MetricBar value={null} interim={7} final={2} />]]} />
          <Steps steps={[{ label: 'Qualification', value: 'Oct 1', state: 'done' }, { label: 'Contract', value: 'Oct 4', state: 'done' }, { label: 'IRB', value: '—', state: 'current' }, { label: 'Green light', value: '—', state: 'todo' }]} />
        </Panel>
      </div>
      <Panel title="Data table (sticky header, sortable)">
        <DataTable rows={rows} rowKey={r => r.id} onRowClick={() => toast('Row opened')} columns={[{ key: 'id', label: 'Site' }, { key: 'name', wrap: true, label: 'Name' },
          { key: 'randomized', label: 'Randomized', align: 'right', render: r => r.randomized, sortValue: r => r.randomized },
          { key: 'status', label: 'Status', render: r => <StatusPill tone={r.status === 'active' ? 'ok' : 'warn'}>{r.status.replace('_', ' ')}</StatusPill> }]} />
      </Panel>
      <div className="grid-2">
        <Panel title="Diff of a proposal">
          <DiffList sections={[{ section: 'objectives', change: 'changed', items: [{ id: 'OBJ1', change: 'added', after: { text: 'Efficacy versus shared control at week 24' } },
            { id: 'OBJ2', change: 'changed', after: { text: 'Safety over 28 weeks' } }] }, { section: 'synopsis', change: 'removed', before: { title: 'Old synopsis' } }]} />
        </Panel>
        <Panel title="Empty, loading and error states">
          <EmptyState title="No tasks here">Nothing is waiting for you.</EmptyState><Loading /><ErrorNote error="The API did not answer." />
        </Panel>
      </div>
      <Panel title="Dialogs and toasts">
        <div className="row"><Button variant="sign" onClick={() => setDialog('sign')}>Open signature dialog</Button>
          <Button onClick={() => setDialog('reason')}>Open reason dialog</Button><Button onClick={() => toast('Saved')}>Show toast</Button>
          <Button onClick={() => toast('Could not save: version is approved', true)}>Show error toast</Button></div>
      </Panel>
      {dialog === 'sign' ? <SignDialog title="Approve Arm appendix v1.0" meaning="approval" what="The version becomes frozen." confirmLabel="Sign and approve"
        onClose={() => setDialog(null)} onSign={async () => { setDialog(null); toast('Signed (catalogue only)'); }} /> : null}
      {dialog === 'reason' ? <ReasonDialog title="Save section" confirmLabel="Save" onClose={() => setDialog(null)} onConfirm={async () => { setDialog(null); toast('Saved'); }} /> : null}
    </AppShell>
  );
}
