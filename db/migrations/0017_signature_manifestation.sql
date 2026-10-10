-- TrialOps · 0017 signature manifestation and AI provenance marker
-- Req: CMP-11 (21 CFR 11.50 / 11.70, Annex 11 §14, JP ERES: the reason is stored on the signature record itself, so the
--      manifestation "name · meaning · UTC time · reason" can be shown on screen, print and export),
--      CMP-09 (AI Act art. 50, FDA–EMA Good AI Practice: accepted AI content keeps a persistent provenance marker).

-- ===== CMP-11: reason on the signature =====
-- Existing signatures keep reason = null (their reason is in the audit row of the signed change). New signatures take
-- the reason of the request (trialops.change_reason, set by the Platform API from X-Change-Reason). The table stays
-- append-only: the trigger only fills the column at insert; core.audit_immutable() still refuses update and delete.
alter table core.signature add column reason text;
comment on column core.signature.reason is 'Reason given by the signer at signing (CMP-11, Part 11 §11.50); filled from trialops.change_reason at insert';

create or replace function core.signature_reason() returns trigger language plpgsql as $$
begin
  new.reason := coalesce(nullif(btrim(current_setting('trialops.change_reason', true)), ''), nullif(btrim(new.reason), ''));
  return new;
end $$;
-- BEFORE INSERT, so the audit row written AFTER INSERT (trigger "audit", 0002) already carries the reason.
create trigger reason_from_request before insert on core.signature for each row execute function core.signature_reason();

-- ===== CMP-09: AI provenance on the accepted appendix version =====
-- {ai_request_id, agent, model, model_version, task_id, reviewed_by, reviewed_by_sub, decision, review_signature_id}
-- Set once by the Platform API when a person accepts (or edits and accepts) an AI proposal; never changed afterwards,
-- and frozen with the rest of the approved version (DM-02).
alter table core.arm_appendix_version add column ai_provenance jsonb;
comment on column core.arm_appendix_version.ai_provenance is 'AI provenance marker of accepted AI-generated content (CMP-09); set once, immutable';

create or replace function core.ai_provenance_guard() returns trigger language plpgsql security definer set search_path = core, public as $$
begin
  if tg_op = 'UPDATE' and old.ai_provenance is not null and new.ai_provenance is distinct from old.ai_provenance then
    raise exception 'AI provenance of % is immutable once recorded (CMP-09)', tg_table_name using errcode = 'insufficient_privilege';
  end if;
  if new.ai_provenance is not null and (tg_op = 'INSERT' or old.ai_provenance is null) then
    if tg_op = 'UPDATE' and old.status <> 'draft' then
      raise exception 'AI provenance can only be recorded on a draft version (CMP-09)' using errcode = 'check_violation';
    end if;
    if jsonb_typeof(new.ai_provenance) <> 'object'
       or coalesce(new.ai_provenance->>'agent', '') = '' or coalesce(new.ai_provenance->>'model', '') = ''
       or coalesce(new.ai_provenance->>'reviewed_by', '') = ''
       or coalesce(new.ai_provenance->>'decision', '') not in ('accepted', 'edited') then
      raise exception 'AI provenance needs agent, model, reviewed_by and decision accepted|edited (CMP-09)' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from core.ai_request r where r.id = (new.ai_provenance->>'ai_request_id')::uuid
                     and r.arm_id is not distinct from new.arm_id) then
      raise exception 'AI provenance must reference the AI ledger request of this arm (CMP-09, AI-06)' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger ai_provenance_guard before insert or update on core.arm_appendix_version
  for each row execute function core.ai_provenance_guard();
