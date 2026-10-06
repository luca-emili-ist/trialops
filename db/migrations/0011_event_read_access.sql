-- TrialOps · 0011 read access to domain events within the caller's perimeter
-- Req: M11-02 (drill-down from a metric to its source events), IAM-02/IAM-03 (perimeter), IAM-04 (no allocation leak)

-- Events never carry subject arm allocation (0004), so reading them by platform/arm/site perimeter is safe for blinded
-- users. Writes stay with core.emit() (security definer); nobody gets insert/update/delete on the outbox.
alter table core.event_outbox enable row level security;
create policy scope on core.event_outbox for select using (
  core.can_see_arm(platform_id, arm_id)
  and core.can_see_site(nullif(data->>'site_id', '')::uuid));
grant select on core.event_outbox to authenticated, app_service;
