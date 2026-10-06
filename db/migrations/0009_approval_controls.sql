-- TrialOps · 0009 approval controls on controlled versions
-- Req: CMP-02 (the approval signature belongs to the version it approves), IAM-05 (separation of duties),
--      APP-DT-04 (platform.protocol.version.approved, arm.appendix.version.approved)

-- Runs before freeze_approved (trigger names fire alphabetically). A version can only be approved with an approval
-- signature on that very version, and never by someone who created or edited it.
create or replace function core.approval_controls() returns trigger language plpgsql security definer set search_path = core, public as $$
declare s core.signature%rowtype;
begin
  if new.status = 'approved' and old.status <> 'approved' and new.approved_signature_id is not null then
    select * into s from core.signature where id = new.approved_signature_id;
    if s.id is null or s.target_table <> tg_table_name or s.target_id <> new.id or s.meaning <> 'approval' then
      raise exception 'approval signature does not belong to this version (CMP-02)' using errcode = 'check_violation';
    end if;
    if exists (select 1 from core.audit_event a where a.table_name = tg_table_name and a.record_id = new.id
                 and a.action in ('INSERT','UPDATE') and a.actor_sub = s.signer_sub) then
      raise exception 'separation of duties: an author of % cannot approve it (IAM-05)', tg_table_name
        using errcode = 'insufficient_privilege';
    end if;
    perform core.emit(case tg_table_name when 'master_protocol_version' then 'platform.protocol.version.approved'
                                         else 'arm.appendix.version.approved' end,
      tg_table_name || '/' || new.id, new.platform_id, (to_jsonb(new)->>'arm_id')::uuid,
      jsonb_build_object('version_label', new.version_label, 'signature_id', s.id));
  end if;
  return new;
end $$;
create trigger approval_controls before update on core.master_protocol_version for each row execute function core.approval_controls();
create trigger approval_controls before update on core.arm_appendix_version for each row execute function core.approval_controls();
