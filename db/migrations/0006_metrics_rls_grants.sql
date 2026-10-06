-- TrialOps · 0006 SURPASS metrics, row level security, grants
-- Req: M11-01, M11-02, IAM-02, IAM-03, IAM-04, IAM-07, APP-DT-06

insert into core.metric_definition(code, ta, name, unit, direction, interim_target, final_target, source_events, formula) values
 ('TA3-IND-FSD',      'TA3','IND submission to first subject dosed (platform)','days','lower_is_better',182,91,
    '{submission.status.changed,subject.randomized}','first randomized - IND initial submitted_at'),
 ('TA3-MP-FSD-ARM',   'TA3','FDA may proceed to FSD, per new arm','days','lower_is_better',91,30,
    '{submission.status.changed,subject.randomized}','first randomized in arm - may_proceed outcome_at'),
 ('TA3-CONTRACT-ARM', 'TA3','Contract execution per new arm','days','lower_is_better',30,7,
    '{arm.created,contract.executed}','arm_addendum executed_at - arm created_at'),
 ('TA3-IRB-ARM',      'TA3','IRB approval per new arm','days','lower_is_better',21,7,
    '{submission.status.changed,irb.approved}','irb_initial outcome_at - submitted_at'),
 ('TA3-ENROLL-DEV',   'TA3','Actual vs predicted enrollment (mean abs deviation across arms)','percent','within_band',50,25,
    '{enrollment.snapshot.published}','mean(|actual-predicted|/predicted)'),
 ('TA3-DATA-COLLECT', 'TA3','Data collection time','days','lower_is_better',7,2,'{visit.completed}','data available - visit date'),
 ('TA3-DATA-CLEAN',   'TA3','Data cleaning and dataset construction','days','lower_is_better',21,7,'{}','dataset ready - freeze'),
 ('TA3-HUMAN-HOURS',  'TA3','Human hours vs historical FTE hours','ratio','lower_is_better',0.5,0.25,'{task.completed}','sum(time_entry.hours)/historical'),
 ('TA3-COST-ARM',     'TA3','Sponsor cost per arm vs lowest of 3 CRO quotes','ratio','lower_is_better',1.0,0.99,'{cost.recorded}','arm cost / min(CRO quotes)');

-- Per-arm onboarding timings, computed from domain records (never typed)
create view core.v_arm_onboarding with (security_barrier) as
select a.platform_id, a.id as arm_id, a.code, a.created_at as arm_created_at,
  c.executed_at as contract_executed_at,
  round(extract(epoch from c.executed_at - a.created_at)/86400.0, 1) as contract_days,
  irb.submitted_at as irb_submitted_at, irb.outcome_at as irb_approved_at,
  round(extract(epoch from irb.outcome_at - irb.submitted_at)/86400.0, 1) as irb_days,
  fda.outcome_at as may_proceed_at,
  fsd.first_randomized_at,
  round(extract(epoch from fsd.first_randomized_at - fda.outcome_at)/86400.0, 1) as may_proceed_to_fsd_days
from core.arm a
left join lateral (select min(executed_at) executed_at from core.contract
   where arm_id = a.id and kind = 'arm_addendum' and status <> 'void') c on true
left join lateral (select submitted_at, outcome_at from core.submission
   where arm_id = a.id and kind = 'irb_initial' and outcome like 'approved%' order by outcome_at limit 1) irb on true
left join lateral (select outcome_at from core.submission
   where arm_id = a.id and kind in ('ind_amendment','ind_initial') and outcome = 'may_proceed' order by outcome_at limit 1) fda on true
left join lateral (select min(h.changed_at) first_randomized_at from core.subject_status_history h
   join core.subject s on s.id = h.subject_id where s.arm_id = a.id and h.to_status = 'randomized') fsd on true
where a.intervention_type <> 'control' and core.can_see_arm(a.platform_id, a.id);

-- Enrollment funnel per site (M05-02) — blinded: no arm breakdown
create view core.v_enrollment_funnel with (security_barrier) as
select s.platform_id, s.site_id,
  count(*) filter (where s.status <> 'void') as identified,
  count(*) filter (where s.status in ('prescreened','consented','screening','screen_failed','randomized','on_treatment','completed','withdrawn')) as prescreened,
  count(*) filter (where s.status in ('consented','screening','screen_failed','randomized','on_treatment','completed','withdrawn')) as consented,
  count(*) filter (where s.status in ('randomized','on_treatment','completed','withdrawn')) as randomized
from core.subject s
where core.can_see_platform(s.platform_id) and core.can_see_site(s.site_id)
group by s.platform_id, s.site_id;

-- SAC enclave: allocation visible only to the unblinded role (IAM-04)
create view sac_enclave.subject_allocation as
  select id as subject_id, platform_id, site_id, arm_id, status from core.subject;
grant select on sac_enclave.subject_allocation to unblinded;

-- ===== Row level security =====
do $$
declare t text;
begin
  -- tables scoped by platform + arm (+ site where present)
  foreach t in array array['arm_appendix_version','arm_stage_transition','site_arm_activation','submission','contract',
                           'document','deviation','task','time_entry'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format($p$create policy scope on core.%I using (core.can_see_arm(platform_id, arm_id)
        and core.can_see_site(%s)) with check (core.can_see_arm(platform_id, arm_id))$p$, t,
        case when t in ('site_arm_activation','contract','document','deviation','task') then 'site_id' else 'null' end);
  end loop;
  foreach t in array array['master_protocol_version','control_sharing_rule','ai_request'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('create policy scope on core.%I using (core.can_see_platform(platform_id)) with check (core.can_see_platform(platform_id))', t);
  end loop;
end $$;

alter table core.platform enable row level security;
create policy scope on core.platform using (core.can_see_platform(id)) with check (core.can_see_platform(id));
alter table core.arm enable row level security;
create policy scope on core.arm using (core.can_see_arm(platform_id, id)) with check (core.can_see_platform(platform_id));
alter table core.site enable row level security;
create policy scope on core.site using (core.can_see_platform(platform_id) and core.can_see_site(id)) with check (core.can_see_platform(platform_id));
alter table core.adverse_event enable row level security;
create policy scope on core.adverse_event using (core.can_see_platform(platform_id) and core.can_see_site(site_id)) with check (core.can_see_platform(platform_id));

-- subject: no direct table access for normal users; they read the blinded view
alter table core.subject enable row level security;
create policy scope on core.subject using (core.can_see_platform(platform_id) and core.can_see_site(site_id))
  with check (core.can_see_platform(platform_id) and core.can_see_site(site_id));

-- ===== Grants (no DELETE anywhere: DM-03) =====
grant select on core.organization, core.person, core.metric_definition to authenticated, app_service;
grant select, insert, update on core.platform, core.role_assignment, core.master_protocol_version, core.arm,
  core.arm_appendix_version, core.arm_stage_transition, core.control_sharing_rule, core.site, core.site_arm_activation,
  core.submission, core.contract, core.document, core.deviation, core.adverse_event, core.task, core.time_entry
  to authenticated, app_service;
grant select, insert on core.document_version, core.signature, core.ai_request, core.agent_decision_record to authenticated, app_service;
grant select, insert, update on core.app_installation to authenticated;
grant select on core.app_scope_grant to authenticated;
grant insert (id, platform_id, site_id, subject_code, status) , update (status) on core.subject to authenticated, app_service;
grant select (id, platform_id, site_id, subject_code, status, status_changed_at, created_at, updated_at, row_version)
  on core.subject to authenticated, app_service;
grant select on core.subject_blinded, core.v_arm_onboarding, core.v_enrollment_funnel to authenticated, app_service;
grant select, insert on core.task_event, core.subject_status_history to authenticated, app_service;
grant usage on all sequences in schema core to authenticated, app_service;
grant execute on all functions in schema core to authenticated, app_service;
-- audit trail: read-only, no table grants to app roles (exposed through the API for QA roles)
