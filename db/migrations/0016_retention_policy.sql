-- 0016 Record retention policy per platform (NFR-04; EU CTR art. 58: TMF kept at least 25 years after the end of the
-- trial; 21 CFR 312.62 / 812.140; J-GCP). The policy is configuration of the platform, audited like any GxP change.
alter table core.platform
  add column retention_years int not null default 25 check (retention_years between 25 and 100),
  add column retention_basis text not null default 'EU CTR art. 58 (25 years after end of trial); covers 21 CFR 312.62 and J-GCP';

comment on column core.platform.retention_years is
  'Minimum years every record of the platform is kept after the end of the trial (NFR-04). Never below 25 (EU CTR art. 58).';
