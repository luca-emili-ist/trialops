-- TrialOps · 0012 AI ledger controls
-- Req: AI-06 (ledger rows are facts: only the human review decision is added later, once), AI-05 (only a person
--      reviews), IAM-03 (a sponsor sees only the AI calls of its own arm)

drop policy scope on core.ai_request;
create policy scope on core.ai_request using (core.can_see_arm(platform_id, arm_id)) with check (core.can_see_arm(platform_id, arm_id));

create or replace function core.ai_request_review() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new) - 'review_decision' - 'reviewer_sub') is distinct from (to_jsonb(old) - 'review_decision' - 'reviewer_sub') then
    raise exception 'AI ledger rows are immutable; only the review decision can be recorded (AI-06)' using errcode = 'insufficient_privilege';
  end if;
  if old.review_decision is not null then
    raise exception 'review decision already recorded for this AI request (AI-06)' using errcode = 'check_violation';
  end if;
  if new.review_decision is null or new.reviewer_sub is null then
    raise exception 'a review needs a decision and a reviewer (AI-05)' using errcode = 'check_violation';
  end if;
  if core.current_actor_type() <> 'user' then
    raise exception 'only a person can review an AI output (AI-05)' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger review before update on core.ai_request for each row execute function core.ai_request_review();
create trigger audit_review after update on core.ai_request for each row execute function core.audit_row('operational');
create trigger no_delete before delete on core.ai_request for each row execute function core.audit_immutable();
grant update (review_decision, reviewer_sub) on core.ai_request to authenticated;
