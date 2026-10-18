import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { db, tx, rejects } from './_helpers.mjs';
let c;
before(async () => { c = await db(); });
after(async () => c.end());

// Tables of the core and sac_enclave schemas that are deliberately not under core.audit_row(), with the reason.
// Adding a table here is a GxP decision: it needs a reason an inspector would accept (CMP-15, rule 10 of CLAUDE.md).
// `immutable: true` means the table must carry the core.audit_immutable() trigger instead.
const NOT_AUDITED = {
  'core.audit_event': { immutable: true, reason: 'the audit ledger itself (append-only, hash-chained)' },
  'core.subject_status_history': { immutable: true, reason: 'history written by the subject state machine; append-only' },
  'core.task_event': { immutable: true, reason: 'history written by the task state machine; append-only' },
  'core.event_outbox': { reason: 'transport queue of domain events derived from audited changes; not a record' },
  'core.data_access_log': { immutable: true, reason: 'the access log itself (CMP-13): append-only, written only by logging functions' },
  'core.audit_seal': { immutable: true, reason: 'Ed25519 seals of the audit ledger (CMP-12): append-only, written by the sealer function' },
  'core.audit_anchor': { immutable: true, reason: 'external copies of the seals (CMP-12): append-only' },
  'core.ddl_event': { immutable: true, reason: 'DDL log written by the event trigger (CMP-12): append-only' },
  'core.oidc_code': { reason: 'single-use authorization codes valid 60 s; stored only as hashes; not a record' },
  'core.idempotency_record': { reason: 'replay cache of API writes (APP-DT-02), kept 24 h, never updated; the write it replays is audited by its own table' },
};

// Audited tables an app can insert into whose rows are not app data (APP-DT-05): their provenance is recorded otherwise.
const NO_APP_PROVENANCE = {
  'core.ai_request': 'AI ledger: provenance is the model, prompt version and input hash (AI-06)',
  'core.agent_decision_record': 'agent decision ledger: provenance is the agent and its AI request (AI-06)',
  'core.signature': 'signatures are made by people only (AI-05); the requesting app is in requested_by_app',
};

test('[APP-DT-05] every audited table an app can write carries provenance columns stamped by the database', async () => {
  const r = await c.query(`
    select n.nspname || '.' || cl.relname as t,
           (select count(*)::int from pg_attribute a where a.attrelid = cl.oid and not a.attisdropped
              and a.attname in ('source_app', 'source_record_id', 'source_version', 'transformation_id')) as cols,
           exists (select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
                    where tg.tgrelid = cl.oid and p.proname = 'stamp_provenance' and tg.tgenabled <> 'D') as stamped
      from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
     where cl.relkind in ('r', 'p') and n.nspname in ('core', 'sac_enclave')
       and has_any_column_privilege('app_service', cl.oid, 'INSERT')
       and exists (select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid where tg.tgrelid = cl.oid and p.proname = 'audit_row')
     order by 1`);
  const missing = r.rows.filter(x => !NO_APP_PROVENANCE[x.t] && (x.cols !== 4 || !x.stamped)).map(x => x.t);
  assert.deepEqual(missing, [], `app-writable tables without provenance: ${missing.join(', ')}`);
  assert.ok(r.rows.length >= 20, 'the app-writable tables are found');
});

test('[CMP-15] every core and sac_enclave table is audited or listed with a justified exception', async () => {
  const r = await c.query(`
    select n.nspname || '.' || cl.relname as t
      from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
     where cl.relkind in ('r', 'p') and n.nspname in ('core', 'sac_enclave')
       and not exists (select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
                        where tg.tgrelid = cl.oid and not tg.tgisinternal and p.proname = 'audit_row')
     order by 1`);
  const unaudited = r.rows.map(x => x.t).filter(t => !NOT_AUDITED[t]);
  assert.deepEqual(unaudited, [], `tables without audit trigger and without a justified exception: ${unaudited.join(', ')}`);
  for (const [t] of Object.entries(NOT_AUDITED).filter(([, e]) => e.immutable)) {
    const m = await c.query(`select count(*)::int n from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
                              where tg.tgrelid = $1::regclass and p.proname = 'audit_immutable'`, [t]);
    assert.ok(m.rows[0].n > 0, `${t} is listed as append-only but has no immutability trigger`);
  }
});

test('[CMP-15] task and subject histories are append-only', async () => {
  await tx(c, async () => { await rejects(c.query('delete from core.task_event'), /append-only/); });
  await tx(c, async () => { await rejects(c.query("update core.subject_status_history set to_status = 'x'"), /append-only/); });
});

test('[VAL-05] requirements carry GxP impact, risk, assurance and known regulatory clauses', () => {
  const req = JSON.parse(readFileSync(new URL('../../docs/requirements.json', import.meta.url), 'utf8')).requirements;
  const cw = JSON.parse(readFileSync(new URL('../../docs/compliance/crosswalk.json', import.meta.url), 'utf8'));
  const codes = new Set(cw.clauses.map(x => x.code));
  for (const r of req) {
    assert.ok(['direct', 'indirect', 'none'].includes(r.gxp_impact), `${r.id} gxp_impact`);
    assert.ok(['high', 'medium', 'low'].includes(r.risk), `${r.id} risk`);
    assert.ok(['scripted', 'automated', 'unscripted'].includes(r.assurance), `${r.id} assurance`);
    assert.ok(r.regs.every(x => codes.has(x)), `${r.id} unknown clause`);
    if (r.gxp_impact === 'direct') assert.ok(r.regs.length > 0, `${r.id} direct impact without clauses`);
    if (r.risk === 'high') assert.equal(r.assurance, 'scripted', `${r.id} high risk needs scripted assurance`);
  }
  for (const f of Object.keys(cw.frameworks)) assert.ok(cw.clauses.some(x => x.framework === f), `framework ${f} has no clauses`);
});
