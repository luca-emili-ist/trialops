# Compliance matrix

Generated 2026-10-10T09:54:56.671Z by scripts/trace.mjs from docs/compliance/crosswalk.json and docs/requirements.json.
Technical clauses are covered by requirements and their tests; procedural clauses are covered by SOPs of the quality system.

## P11 — US 21 CFR Part 11 — Electronic records; electronic signatures

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| P11-10a | §11.10(a) | Validation for accuracy, reliability, consistent intended performance, ability to discern invalid or altered records | technical | VAL-01 (v1: NO TEST), VAL-02 (v1: NO TEST), VAL-05 (gxp-p0: PASS) | partial |
| P11-10b | §11.10(b) | Accurate and complete copies in human readable and electronic form for inspection | technical | CMP-10 (gxp-p0: PASS), CMP-14 (v1: NO TEST) | partial |
| P11-10c | §11.10(c) | Protection of records for accurate and ready retrieval throughout the retention period | technical | NFR-04 (gxp-p0: PASS) | covered |
| P11-10d | §11.10(d) | Limiting system access to authorized individuals | technical | IAM-02 (foundations: PASS), APP-MF-04 (foundations: PASS), APP-ID-01 (v0: PASS), IAM-01 (gxp-p0: PASS), CMP-03 (gxp-p0: PASS), IAM-06 (v2: NO TEST), APP-ID-03 (v2: NO TEST) | partial |
| P11-10e | §11.10(e) | Secure, computer-generated, time-stamped audit trail; changes do not obscure previous values | technical | CMP-01 (foundations: PASS), CMP-04 (foundations: PASS), DM-03 (foundations: PASS), AI-06 (foundations: PASS), APP-TK-02 (foundations: PASS), AI-08 (v1: NO TEST), APP-AU-01 (v2: NO TEST), EDC-05 (v1: NO TEST), CMP-10 (gxp-p0: PASS), CMP-15 (gxp-p0: PASS), CMP-12 (v1: NO TEST) | partial |
| P11-10f | §11.10(f) | Operational system checks to enforce permitted sequencing of steps | technical | DM-02 (foundations: PASS), IAM-05 (foundations: PASS), AI-05 (foundations: PASS), APP-TK-02 (foundations: PASS), APP-TK-04 (foundations: PASS), M01-04 (foundations: PASS), M07-01 (foundations: PASS), M01-01 (v0: PASS), M02-03 (v0: PASS), EDC-04 (v1: NO TEST), EDC-08 (v2: NO TEST) | partial |
| P11-10g | §11.10(g) | Authority checks: only authorized individuals can use, sign, alter or access records | technical | IAM-02 (foundations: PASS), IAM-03 (foundations: PASS), IAM-04 (foundations: PASS), IAM-05 (foundations: PASS), APP-MF-02 (foundations: PASS), APP-ID-02 (v0: PASS), APP-ID-02 (foundations: PASS), APP-TK-03 (v1: NO TEST), AI-07 (v1: NO TEST) | partial |
| P11-10h | §11.10(h) | Device checks to determine validity of the source of data input | technical | EDC-03 (v1: NO TEST), APP-DT-05 (v1: NO TEST) | planned |
| P11-10i | §11.10(i) | Persons who develop, maintain or use the system have education, training and experience | procedural | — | SOP |
| P11-10j | §11.10(j) | Written policies holding individuals accountable for actions under their e-signatures | procedural | — | SOP |
| P11-10k | §11.10(k) | Controls over system documentation (distribution, access, change control) | procedural | — | SOP |
| P11-30 | §11.30 | Open systems: additional measures such as encryption | technical | NFR-05 (v1: NO TEST) | planned |
| P11-50 | §11.50 | Signature manifestation: printed name, date and time, meaning, shown on display and printout | technical | EDC-07 (v2: NO TEST), CMP-11 (gxp-p0: PASS) | partial |
| P11-70 | §11.70 | Signatures linked to their records so they cannot be excised, copied or transferred | technical | CMP-02 (foundations: PASS), DM-02 (foundations: PASS), EDC-07 (v2: NO TEST) | partial |
| P11-100a | §11.100(a) | Each e-signature unique to one individual, never reused or reassigned | technical | CMP-02 (foundations: PASS) | covered |
| P11-100b | §11.100(b) | Identity verified before establishing an e-signature | procedural | — | SOP |
| P11-100c | §11.100(c) | Certification to FDA that e-signatures are legally binding equivalent of handwritten | procedural | — | SOP |
| P11-200a | §11.200(a) | Two distinct identification components; series of signings in one session; use only by genuine owner | technical | IAM-01 (gxp-p0: PASS) | covered |
| P11-300 | §11.300 | Controls for identification codes/passwords: uniqueness, periodic revision, loss management, safeguards against unauthorized use | technical | APP-ID-01 (v0: PASS), IAM-01 (gxp-p0: PASS), CMP-03 (gxp-p0: PASS) | covered |

## FDA-ESQA — US FDA guidance — Electronic Systems, Electronic Records, and Electronic Signatures in Clinical Investigations: Q&A (Oct 2024)

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| FDA-ESQA-CLOUD | Q&A sections on IT service providers | Sponsor oversight of IT service providers; agreements; access to records for inspection | procedural | — | SOP |
| FDA-ESQA-AUDIT | Q&A on audit trails | Audit trail capture and review proportionate to risk | technical | CMP-01 (foundations: PASS), CMP-10 (gxp-p0: PASS) | covered |
| FDA-ESQA-RETAIN | Q&A on record retention | Records and metadata retained and available for the required period (21 CFR 312.62, 812.140) | technical | NFR-04 (gxp-p0: PASS) | covered |

## A11 — EU EudraLex Vol. 4 Annex 11 — Computerised systems (2011; revision draft 2025 not adopted)

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| A11-1 | §1 | Risk management throughout the lifecycle | procedural | — | SOP |
| A11-3 | §3 | Suppliers and service providers: agreements, assessment | procedural | VAL-04 (v1: NO TEST) | SOP |
| A11-4 | §4 | Validation: URS, traceability, change control, data migration | technical | EDC-01 (v1: NO TEST), EDC-02 (v2: NO TEST), AI-03 (v1: NO TEST), VAL-01 (v1: NO TEST), VAL-02 (v1: NO TEST), VAL-03 (v1: NO TEST), VAL-05 (gxp-p0: PASS) | partial |
| A11-5 | §5 | Built-in checks for correct and secure data exchange | technical | APP-MF-01 (foundations: PASS), APP-DT-04 (foundations: PASS), APP-TK-03 (v1: NO TEST), APP-DT-01 (v2: PASS), APP-DT-02 (v1: NO TEST) | partial |
| A11-6 | §6 | Accuracy checks on critical data entered manually | technical | EDC-04 (v1: NO TEST) | planned |
| A11-7 | §7 | Data storage: protection, accessibility, regular backups, restore tested | technical | NFR-04 (gxp-p0: PASS) | covered |
| A11-8 | §8 | Printouts: clear printed copies, indication of changes | technical | CMP-11 (gxp-p0: PASS), CMP-14 (v1: NO TEST) | partial |
| A11-9 | §9 | Audit trails: record of GMP-relevant changes and deletions with reason; available, convertible, regularly reviewed | technical | CMP-01 (foundations: PASS), CMP-04 (foundations: PASS), DM-03 (foundations: PASS), APP-AU-01 (v2: NO TEST), CMP-10 (gxp-p0: PASS), CMP-15 (gxp-p0: PASS), CMP-12 (v1: NO TEST) | partial |
| A11-10 | §10 | Change and configuration management | procedural | VAL-02 (v1: NO TEST) | SOP |
| A11-11 | §11 | Periodic evaluation | procedural | — | SOP |
| A11-12 | §12 | Security: physical and logical access controls, creation/change/cancellation of access authorizations recorded | technical | IAM-02 (foundations: PASS), IAM-03 (foundations: PASS), IAM-05 (foundations: PASS), APP-MF-02 (foundations: PASS), APP-MF-04 (foundations: PASS), APP-ID-01 (v0: PASS), APP-ID-02 (v0: PASS), APP-ID-02 (foundations: PASS), IAM-01 (gxp-p0: PASS), CMP-03 (gxp-p0: PASS), IAM-06 (v2: NO TEST) | partial |
| A11-13 | §13 | Incident management | procedural | — | SOP |
| A11-14 | §14 | Electronic signature: same impact as handwritten, permanently linked, time and date | technical | CMP-02 (foundations: PASS), DM-02 (foundations: PASS), CMP-11 (gxp-p0: PASS) | covered |
| A11-16 | §16 | Business continuity | procedural | — | SOP |
| A11-17 | §17 | Archiving: accessibility, readability and integrity over the retention period | technical | NFR-04 (gxp-p0: PASS) | covered |

## EMA-CS — EU EMA Guideline on computerised systems and electronic data in clinical trials (EMA/INS/GCP/112288/2023)

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| EMA-CS-ALCOA | data integrity principles (ALCOA++) | Data attributable, legible, contemporaneous, original, accurate, complete, consistent, enduring, available, traceable | technical | CMP-04 (foundations: PASS), DM-01 (foundations: PASS), AI-06 (foundations: PASS), EDC-03 (v1: NO TEST), EDC-05 (v1: NO TEST), CMP-09 (gxp-p0: PASS), AI-04 (v1: NO TEST), APP-DT-02 (v1: NO TEST), APP-DT-05 (v1: NO TEST) | partial |
| EMA-CS-AUDIT | audit trail | Audit trail of all changes incl. who, when, old/new value, reason; cannot be disabled | technical | CMP-01 (foundations: PASS), DM-03 (foundations: PASS), APP-AU-01 (v2: NO TEST), CMP-15 (gxp-p0: PASS) | partial |
| EMA-CS-AUDITREVIEW | audit trail review | Audit trail available in readable form and reviewed risk-based (routine and for-cause) | technical | CMP-10 (gxp-p0: PASS) | covered |
| EMA-CS-SIGNOFF | sign-off of data / e-signatures | Electronic signatures and sign-off of data by responsible persons | technical | CMP-02 (foundations: PASS), APP-TK-04 (foundations: PASS), EDC-06 (v2: NO TEST), EDC-07 (v2: NO TEST), CMP-11 (gxp-p0: PASS) | partial |
| EMA-CS-CERTCOPY | copying data, certified copies | Certified copies preserving content and meaning, including metadata | technical | CMP-14 (v1: NO TEST) | planned |
| EMA-CS-INVCONTROL | control of data | Investigator keeps control of and continuous access to site-generated data; sponsor must not have exclusive control | technical | EDC-03 (v1: NO TEST) | planned |
| EMA-CS-BACKUP | backup and restore | Backup and restore validated and periodically tested | technical | NFR-04 (gxp-p0: PASS) | covered |
| EMA-CS-ARCHIVE | archiving | Archiving for the retention period with readability | technical | NFR-04 (gxp-p0: PASS) | covered |
| EMA-CS-MIGRATION | migration | Validated data migration preserving audit trail and signatures | technical | VAL-03 (v1: NO TEST) | planned |
| EMA-CS-VALID | Annex 2 Computerised system validation | Risk-based validation, requirements, traceability, test evidence, change control | technical | VAL-01 (v1: NO TEST), VAL-02 (v1: NO TEST), VAL-05 (gxp-p0: PASS) | partial |
| EMA-CS-USERMGMT | Annex 3 User management | Unique accounts, role-based access, periodic access review, timely revocation, MFA where appropriate | technical | IAM-02 (foundations: PASS), APP-ID-01 (v0: PASS), IAM-01 (gxp-p0: PASS), IAM-06 (v2: NO TEST), APP-ID-03 (v2: NO TEST) | partial |
| EMA-CS-SECURITY | Annex 4 Security | Security: encryption, vulnerability management, penetration testing, session timeout, lockout | technical | IAM-01 (gxp-p0: PASS), CMP-03 (gxp-p0: PASS), NFR-05 (v1: NO TEST) | partial |
| EMA-CS-IRT | Annex 5 IRT | Randomisation and IRT: protected allocation, emergency unblinding logged | technical | IAM-04 (foundations: PASS), CMP-13 (v1: NO TEST) | partial |
| EMA-CS-ECONSENT | Annex 5 eConsent | eConsent: identity, approved version, copy to the subject | technical | — | GAP — no requirement |
| EMA-CS-CLOUD | Annex 1 Agreements / cloud | Agreements with service providers; data location; exit | procedural | — | SOP |

## CTR — EU Regulation 536/2014 on clinical trials

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| CTR-57 | Art. 57 | Trial master file always complete, readily available and directly accessible | technical | M09-02 (v1: NO TEST), CMP-14 (v1: NO TEST) | planned |
| CTR-58 | Art. 58 | Archiving of the TMF for at least 25 years after the end of the trial | technical | NFR-04 (gxp-p0: PASS) | covered |

## E6R3 — ICH E6(R3) Good Clinical Practice (principles, Annex 1, Annex 2)

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| E6R3-BLINDING | Data governance — safeguard blinding | Blinding protected in data governance and system access | technical | IAM-03 (foundations: PASS), IAM-04 (foundations: PASS), IAM-07 (foundations: PASS), AI-11 (foundations: PASS), M05-02 (foundations: PASS), APP-ID-02 (v0: PASS), APP-ID-02 (foundations: PASS), EDC-11 (v1: NO TEST), CMP-13 (v1: NO TEST) | partial |
| E6R3-DATALIFECYCLE | Data governance — data life cycle | Data capture, metadata, review, correction, transfer, finalisation, retention, destruction | technical | CMP-04 (foundations: PASS), DM-01 (foundations: PASS), M01-04 (foundations: PASS), EDC-01 (v1: NO TEST), EDC-02 (v2: NO TEST), EDC-08 (v2: NO TEST), CMP-05 (v1: NO TEST), APP-DT-05 (v1: NO TEST) | partial |
| E6R3-COMPSYS | Data governance — computerised systems | Fit-for-purpose systems: validation, audit trail, access control, security, backup, vendor oversight | technical | CMP-01 (foundations: PASS), IAM-02 (foundations: PASS), NFR-04 (gxp-p0: PASS), VAL-02 (v1: NO TEST) | partial |
| E6R3-RBQM | Quality management / risk-based approach | Critical-to-quality factors, risk-based quality management and monitoring | technical | M05-02 (foundations: PASS), M11-02 (foundations: PASS), M08-02 (v1: NO TEST), EDC-12 (v1: NO TEST), EDC-06 (v2: NO TEST), CMP-05 (v1: NO TEST) | partial |
| E6R3-SERVICEPROVIDER | Sponsor — service providers | Oversight of service providers, including computerised system providers | procedural | APP-MF-01 (foundations: PASS), APP-MF-02 (foundations: PASS), CMP-05 (v1: NO TEST), VAL-04 (v1: NO TEST) | SOP |
| E6R3-CONSENT | Informed consent incl. electronic | Informed consent process, versioning, documentation | technical | — | GAP — no requirement |
| E6R3-SAFETY | Safety assessment and reporting | Expedited reporting timelines, safety information flow | technical | M07-01 (foundations: PASS) | covered |
| E6R3-RECORDS | Essential records | Essential records available, retained and protected | technical | M01-01 (v0: PASS), M02-01 (v0: PASS), M02-03 (v0: PASS), M04-02 (v1: NO TEST), M09-02 (v1: NO TEST) | partial |

## JP-ERES — JP MHLW PFSB Notification 0401022 (2005) — Electronic records and electronic signatures

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| JP-ERES-AUTH | Authenticity (真正性) | Records protected against falsification/erasure; responsibility clear; audit trail | technical | CMP-01 (foundations: PASS), DM-02 (foundations: PASS), DM-03 (foundations: PASS), CMP-12 (v1: NO TEST) | partial |
| JP-ERES-LEGIB | Legibility (見読性) | Records can be displayed and printed in readable form | technical | CMP-10 (gxp-p0: PASS), CMP-14 (v1: NO TEST) | partial |
| JP-ERES-PRESERV | Preservation (保存性) | Records preserved for the retention period, backups | technical | NFR-04 (gxp-p0: PASS) | covered |
| JP-ERES-ESIG | Electronic signatures | E-signature linked to record, signer identity, date/time, meaning | technical | CMP-02 (foundations: PASS), EDC-07 (v2: NO TEST), CMP-11 (gxp-p0: PASS) | partial |

## JP-CSV — JP MHLW PFSB/CND Notification 1021-11 (2010) — Computerized system management guideline

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| JP-CSV-LIFECYCLE | Development and validation documents | Category-based lifecycle: development plan, requirements, design, tests, validation report, change control | technical | VAL-01 (v1: NO TEST), VAL-02 (v1: NO TEST), VAL-05 (gxp-p0: PASS) | partial |

## JP-GCP — JP MHLW Ordinance No. 28 (1997), GCP, with E6(R3) incorporation planned FY2026

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| JP-GCP-RECORDS | Retention of essential documents | Retention of records by sponsor and site for the period required by J-GCP | technical | NFR-04 (gxp-p0: PASS), NFR-07 (v1: NO TEST) | partial |

## GDPR — EU Regulation 2016/679

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| GDPR-25 | Art. 25 | Data protection by design and by default (pseudonymisation, minimisation) | technical | DM-05 (foundations: PASS), IAM-03 (foundations: PASS), M05-01 (v1: NO TEST), DEMO-04 (v0: PASS), CMP-08 (v1: NO TEST) | partial |
| GDPR-28 | Art. 28 | Processors under contract (DPA) | procedural | — | SOP |
| GDPR-30 | Art. 30 | Record of processing activities | procedural | — | SOP |
| GDPR-32 | Art. 32 | Security of processing | technical | AI-01 (v0: PASS), CMP-08 (v1: NO TEST), NFR-05 (v1: NO TEST) | partial |
| GDPR-35 | Art. 35 | Data protection impact assessment | procedural | — | SOP |
| GDPR-44 | Art. 44–49 | Transfers outside the EU | technical | CMP-08 (v1: NO TEST), NFR-06 (v1: NO TEST) | planned |

## HIPAA — US 45 CFR 160/164 (Security Rule technical safeguards)

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| HIPAA-312 | 45 CFR 164.312 | Technical safeguards: access control, audit controls, integrity, authentication, transmission security | technical | CMP-01 (foundations: PASS), IAM-02 (foundations: PASS), AI-01 (v0: PASS), IAM-01 (gxp-p0: PASS), CMP-03 (gxp-p0: PASS), CMP-13 (v1: NO TEST), CMP-08 (v1: NO TEST), NFR-05 (v1: NO TEST), NFR-06 (v1: NO TEST) | partial |
| HIPAA-BAA | 45 CFR 164.504(e) | Business associate agreements with service providers handling PHI | procedural | — | SOP |

## APPI — JP Act on the Protection of Personal Information (Act 57/2003, rev. 2022)

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| APPI-SENSITIVE | Special care-required personal information | Health data handled with consent and security controls; pseudonymisation | technical | DM-05 (foundations: PASS), M05-01 (v1: NO TEST), CMP-08 (v1: NO TEST) | partial |
| APPI-TRANSFER | Cross-border transfer (Art. 28) | Transfer of personal data outside Japan only with adequacy, safeguards or consent | technical | CMP-08 (v1: NO TEST), NFR-06 (v1: NO TEST) | planned |

## AIACT — EU Regulation 2024/1689 (AI Act) as amended by the AI Omnibus (2026)

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| AIACT-4 | Art. 4 | AI literacy of staff and users | procedural | — | SOP |
| AIACT-50 | Art. 50 (applies from 2 Dec 2026) | Transparency: AI-generated content marked and users informed | technical | AI-05 (foundations: PASS), M01-02 (v0: PASS), CMP-09 (gxp-p0: PASS) | covered |

## FDA-AI — US FDA draft guidance — Considerations for the Use of AI to Support Regulatory Decision-Making (Jan 2025) + FDA–EMA Guiding Principles of Good AI Practice (Jan 2026)

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| FDA-AI-COU | Credibility framework steps 1–3 | Question of interest, context of use, model risk (influence × decision consequence) | technical | M05-01 (v1: NO TEST), CMP-06 (v1: NO TEST), AI-02 (v1: NO TEST) | planned |
| FDA-AI-CRED | Credibility framework steps 4–7 | Credibility assessment plan, execution, report, adequacy for the context of use | technical | CMP-06 (v1: NO TEST), CMP-07 (v1: NO TEST), AI-02 (v1: NO TEST), AI-04 (v1: NO TEST) | planned |
| FDA-AI-LIFECYCLE | Life cycle maintenance; Good AI Practice principle 9 | Model change control, performance monitoring, drift | technical | AI-06 (foundations: PASS), AI-01 (v0: PASS), AI-09 (v1: PASS), CMP-07 (v1: NO TEST), AI-03 (v1: NO TEST), AI-10 (v1: NO TEST) | partial |
| FDA-AI-HUMAN | Good AI Practice principles 1, 3 | Human-centric design and oversight, adherence to GxP | technical | IAM-07 (foundations: PASS), AI-05 (foundations: PASS), AI-11 (foundations: PASS), APP-TK-04 (foundations: PASS), M01-02 (v0: PASS), AI-07 (v1: NO TEST), AI-08 (v1: NO TEST), M04-02 (v1: NO TEST), M05-01 (v1: NO TEST), M08-02 (v1: NO TEST), M09-02 (v1: NO TEST), AI-09 (v1: PASS), CMP-09 (gxp-p0: PASS) | partial |

## CDISC — FDA Data Standards Catalog / PMDA electronic study data (CDISC SDTM, ADaM, Define-XML, ODM)

| Clause | Ref | Title | Control | Requirements (release: result) | Status |
| --- | --- | --- | --- | --- | --- |
| CDISC-SUB | FDA Data Standards Catalog; PMDA electronic study data | Study data in CDISC standards (SDTM/ADaM/Define-XML; CDASH, ODM for collection) | technical | EDC-01 (v1: NO TEST) | planned |
