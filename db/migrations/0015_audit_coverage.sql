-- 0015 Audit coverage of every core table (CMP-15; Part 11 §11.10(e), Annex 11 §9, EMA 2023 audit trail).
-- Tables that were protected only by missing grants now carry the audit trigger or an immutability trigger.
-- The remaining exceptions are listed, with their reason, in db/tests/compliance.test.mjs.

-- Agent Decision Records: immutable facts (0005); now their creation is in the audit ledger too (AI-08).
create trigger audit after insert on core.agent_decision_record
  for each row execute function core.audit_row('gxp');

-- App scope grants are access authorizations: creation and revocation recorded (Annex 11 §12, APP-MF-02/04).
create trigger audit after insert or update on core.app_scope_grant
  for each row execute function core.audit_row('operational');
create trigger no_delete before delete on core.app_scope_grant
  for each row execute function core.audit_row('operational');

-- SURPASS metric definitions are configuration: changes recorded.
create trigger audit after insert or update on core.metric_definition
  for each row execute function core.audit_row('operational');
create trigger no_delete before delete on core.metric_definition
  for each row execute function core.audit_row('operational');

-- History tables written by state-machine triggers are themselves audit records: make them append-only.
create trigger immutable before update or delete on core.subject_status_history
  for each row execute function core.audit_immutable();
create trigger immutable_truncate before truncate on core.subject_status_history
  execute function core.audit_immutable();
create trigger immutable before update or delete on core.task_event
  for each row execute function core.audit_immutable();
create trigger immutable_truncate before truncate on core.task_event
  execute function core.audit_immutable();
