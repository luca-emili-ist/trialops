-- TrialOps · 0010 site activation controls
-- Req: M02-03 (per-arm activation workflow: qualification, contract, IRB, training, green light, each with a date)

-- Green light is the last step: it needs every earlier step dated, in order. Enforced in the database so that apps and
-- the UI cannot activate a site for an arm by skipping a step.
create or replace function core.site_activation_order() returns trigger language plpgsql as $$
declare
  steps text[] := array['qualified_at','contract_executed_at','irb_approved_at','training_done_at','green_light_at'];
  j jsonb := to_jsonb(new);
  prev timestamptz; cur timestamptz; i int;
begin
  for i in 1 .. array_length(steps, 1) loop
    cur := (j->>steps[i])::timestamptz;
    if cur is not null then
      if i > 1 and prev is null then
        raise exception 'site activation step % needs % first (M02-03)', steps[i], steps[i-1] using errcode = 'check_violation';
      end if;
      if prev is not null and cur < prev then
        raise exception 'site activation step % cannot precede % (M02-03)', steps[i], steps[i-1] using errcode = 'check_violation';
      end if;
    end if;
    prev := cur;
  end loop;
  return new;
end $$;
create trigger activation_order before insert or update on core.site_arm_activation
  for each row execute function core.site_activation_order();
