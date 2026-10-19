# Privacy by design (GDPR, HIPAA, APPI)

Requirement: **CMP-08** — pseudonymisation in the core, minimisation, record of processing activities, DPA/BAA with every
provider, data residency per region (GDPR art. 25, 32, 44; HIPAA §164.312; APPI special care-required information and
cross-border transfer). Technical controls: migration `0026_quality_privacy_governance.sql`, API tag `privacy`.
Human review of the design: `docs/compliance/evidence/HR-2026-10-19_CMP-08_privacy-by-design.md`.

## 1. Pseudonymisation and minimisation

- The core holds trial participants only under a pseudonym: `core.subject.subject_code` must match
  `^[A-Z0-9][A-Z0-9-]{1,39}$` (site number + sequence; no names, e-mails, dates). Identity stays with the site or the
  eConsent app.
- The link pseudonym → identity record is kept in `sac_enclave.reidentification_key` (an opaque reference held by the
  custodian and the id of the pseudonymisation key in the vault — never the identity nor the key material).
  No API role has a grant on it. The site or the eConsent app writes it through `core.register_reidentification()`
  (inside its own site perimeter). Only an unblinded SAC person reads it, through `sac_enclave.reidentify()`, with a
  reason; each read is in the access log (CMP-13). Agents are never unblinded (IAM-07).
- Minimisation: no direct-identifier columns (name, birth date, phone, e-mail, address, MRN, national id…) in core tables
  that hold participant data; the privacy check fails if one appears.

## 2. Record of processing activities (GDPR art. 30)

- `core.ropa_entry`, one row per version (`ROPA-NNN`, version 1, 2, …): purpose, controller, legal basis per region
  (EU/US/JP), data subjects, data categories, recipients (service provider codes), regions, transfers, retention,
  security measures.
- A version is drafted (`POST /v1/privacy/ropa`), approved by a person other than its author
  (`POST /v1/privacy/ropa/{id}/approve`, platform admin or QA, reason required); the previous approved version is
  superseded. Approval needs a legal basis for every region and recipients present in the provider registry. Approved
  versions never change. Review at least yearly and whenever a provider or purpose changes.

## 3. Agreements per provider

Required, by the database, before a provider becomes active and for each participant-data category
(`pseudonymised_clinical`, `identifiable_health`) and region it processes:

| Region | Agreement | Basis |
| --- | --- | --- |
| EU | `DPA` | GDPR art. 28 |
| US | `BAA` | HIPAA §164.504(e) (pseudonymised data treated as PHI) |
| JP | `APPI_TRANSFER` | APPI basis for providing personal data to the provider (entrustment / art. 27–28) |
| any, GxP-relevant provider | `QUALITY_AGREEMENT` | ICH E6(R3) service providers, Annex 11 §3 |

An agreement counts only if `effective`, within its dates, and naming the category and region. An effective agreement
needs the SHA-256 of the signed document and cannot be edited (terminate and record a new one). Expired or terminated
agreements of an active provider are reported by the privacy check.

## 4. Data residency

- Each platform declares once where its data stays: `POST /v1/platforms/{id}/data-region` (EU, US or JP); it cannot be
  moved afterwards.
- A provider receives participant data of a platform (`POST /v1/platforms/{id}/providers`) only if it is active, processes
  in the platform region and holds the agreement of that region. Non-participant categories (operational, sponsor
  confidential) are not bound to the region. Runtimes ask `core.provider_allowed(platform, provider, category)` before
  sending data (to be wired into the AI runtime routing).
- An app is activated only if its manifest `data_residency` includes the platform region.

## 5. Privacy check

`GET /v1/privacy/check[?platform_id=]` (QA, platform admin) runs: no identifier columns on participant data, subject
codes in pseudonym form, re-identification link not readable by any API role, allocation not readable by blinded roles,
region declared, providers in region with agreements, agreements of active providers valid, oversight not overdue,
every active provider with participant data recorded in an approved ROPA entry. Run it before every promotion to
production and monthly; a failed check opens a deviation.
