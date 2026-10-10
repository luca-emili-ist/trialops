# TrialOps — Analisi regolatoria e piano "GCP by design"

Versione 0.2 · 2026-10-10 · autore: Claude per Luca Emili · stato: approvato da Luca il 2026-10-10 (decisioni in §5)

Scopo: elencare gli standard che TrialOps deve rispettare per essere usato in sperimentazioni cliniche GCP negli
Stati Uniti, nell'Unione Europea e in Giappone; confrontarli con quello che c'è oggi nel codice e nella specifica
(`docs/SPEC.md` §9–§11); definire come cambiare il processo di sviluppo perché ogni release esca già
"validation-ready" e il cliente possa qualificarla senza riscrivere nulla.

Lo stato normativo è verificato al 9 ottobre 2026. Le voci marcate **[verificare]** vanno controllate sul testo
ufficiale prima di citarle in un documento esterno.

---

## 1. Premessa: cosa vuol dire "certificato" per un software GCP

Non esiste una certificazione 21 CFR Part 11, EU Annex 11, GAMP 5 o GCP rilasciata a un software. FDA, EMA e
PMDA non certificano prodotti software per le sperimentazioni cliniche. La responsabilità è del **soggetto
regolato** (sponsor, CRO, sito sperimentale): deve dimostrare che ogni sistema computerizzato è **idoneo all'uso
previsto** ("fit for purpose", ICH E6(R3) §4.3) e che è stato **validato** in modo proporzionato al rischio.

Per un fornitore come InSilicoTrials questo si traduce in tre cose concrete:

1. **Prodotto conforme by design.** I controlli tecnici richiesti dalle norme sono nel codice: audit trail, firme,
   accessi, integrità dei dati, conservazione, controllo dell'AI.
2. **Evidenze di sviluppo riutilizzabili.** Il cliente può basare la propria validazione sulla documentazione del
   fornitore (GAMP 5 2ª ed., FDA CSA, EMA 2023 §4.5), senza ripetere i test. Servono requisiti con rischio,
   tracciabilità, test con evidenze, change control e release firmate.
3. **Un fornitore auditabile.** Il cliente farà un *supplier audit* su InSilicoTrials. Servono un sistema qualità
   (QMS) con SOP, persone formate e una funzione QA indipendente dallo sviluppo.

Le certificazioni ottenibili sono quelle **dell'organizzazione**, non del prodotto: ISO 9001 o ISO 13485 per il QMS,
ISO/IEC 27001 (con 27017/27018/27701) per la sicurezza, SOC 2 Type II, ISO/IEC 42001 per la gestione dell'AI. A
queste si aggiunge un **assessment indipendente Part 11 / Annex 11** fatto da una società di consulenza GxP: è il
documento che i clienti chiedono davvero. "Certificato" nel linguaggio commerciale vuol dire questo pacchetto.

Nota sul modello open source (AGPL-3.0): chi usa il codice open source deve validarlo da solo. Il valore
regolatorio sta nella **distribuzione qualificata** di IST (release firmate, pacchetto di validazione, hosting
qualificato, supporto). Va detto nel posizionamento della proposta SURPASS.

---

## 2. Mappa degli standard

Legenda: **V** = vincolante (legge o regolamento); **G** = guidance o linea guida, attesa dagli ispettori;
**S** = standard volontario o di settore, di fatto richiesto dai clienti.

### 2.1 Internazionale (ICH e organismi trasversali)

| Riferimento | Tipo | Stato al 2026-10 | Cosa chiede a TrialOps |
| --- | --- | --- | --- |
| **ICH E6(R3)** GCP — principi + Annex 1 | G (V una volta recepita) | Step 4 il 6 gen 2025; in vigore in UE dal 23 lug 2025; FDA l'ha pubblicata come guidance | §4.2 governance dei dati; §4.3 sistemi computerizzati (validazione, audit trail, controllo accessi, sicurezza, backup, gestione del fornitore); approccio basato sul rischio (RBQM); ricostruibilità del trial |
| **ICH E6(R3) Annex 2** (elementi decentralizzati, pragmatici, real-world data) | G | Step 4 il 3 giu 2026; in UE in vigore dal **15 gen 2027**; FDA e MHLW: data non ancora fissata | eConsent, dati raccolti a distanza, DHT, provenienza dei dati RWD |
| ICH E8(R1) | G | in vigore | Qualità by design, fattori critici per la qualità (CtQ) |
| ICH E9 / E9(R1), **ICH E20** (disegni adattivi) | G | E20 in bozza Step 2 dal 2025 [verificare] | Integrità degli adattamenti, firewall delle informazioni ad interim (enclave SAC) |
| **ICH M11** (CeSHarP, protocollo strutturato) | G | [verificare lo Step 4] | Protocollo strutturato e scambiabile (già usato in M01) |
| ICH E2A / **E2B(R3)** | G (V per la segnalazione) | in vigore | Clock di segnalazione SUSAR, messaggi ICSR E2B(R3), MedDRA |
| ICH M8 / M4 (eCTD) | G | in vigore | Formato degli invii regolatori (fuori dal core, ma i documenti TMF devono essere esportabili) |
| **PIC/S PI 041-1** Data integrity (2021) | G | in vigore | ALCOA+, governance dei dati, revisione dell'audit trail |
| WHO TRS 1033 Annex 4 (data integrity) | G | in vigore | Come sopra |
| **GAMP 5 2ª ed.** (ISPE, 2022) + GPG Records & Data Integrity + **ISPE GAMP Guide: AI** (2025) | S | in vigore | Ciclo di vita del sistema, categorie software, approccio critico (CSA), validazione dei modelli AI |
| FDA–EMA *Guiding Principles of Good AI Practice in Drug Development* | G | pubblicati il 14 gen 2026 | 10 principi: centralità della persona, rischio, aderenza GxP, contesto d'uso, governance dei dati, ciclo di vita |
| **CDISC**: CDASH, SDTM, ADaM, Define-XML, ODM v2, Dataset-JSON, USDM | S (V per gli invii FDA e PMDA) | in vigore | Raccolta (EDC) ed export dei dataset |
| HL7 **FHIR R4** | S | in vigore | Interoperabilità con EHR e RWD |
| ISO 9001 / ISO 13485, ISO/IEC 27001:2022 (+27017, 27018, 27701), **ISO/IEC 42001**, SOC 2 Type II | S | in vigore | QMS e sicurezza del fornitore (certificazioni dell'organizzazione) |
| ISO 14155:2020 | S (armonizzata in UE) | in vigore | Solo per bracci con dispositivi medici |

### 2.2 Stati Uniti

| Riferimento | Tipo | Stato | Cosa chiede |
| --- | --- | --- | --- |
| **21 CFR Part 11** | V | in vigore (1997) | §11.10(a)–(k) validazione, copie accurate, conservazione, accessi, audit trail, controlli operativi, di autorità e di dispositivo, formazione, SOP; §11.50/11.70 manifestazione e legame della firma; §11.100/11.200/11.300 identità, componenti della firma, controlli su ID e password |
| Guidance *Part 11 — Scope and Application* (2003) | G | in vigore | Approccio basato sul rischio; discrezionalità su validazione, audit trail e copie |
| **Guidance *Electronic Systems, Electronic Records, and Electronic Signatures in Clinical Investigations — Q&A*** | G | finale ott 2024; sostituisce la guidance 2007 sui sistemi computerizzati nelle sperimentazioni | La guidance più rilevante per TrialOps: sistemi IT e servizi cloud, DHT, audit trail, firme, controllo del fornitore, conservazione dei dati |
| 21 CFR 312 (IND), 812 (IDE), 50 (consenso), 56 (IRB); 45 CFR 46 (Common Rule) | V | in vigore | Registri e conservazione (312.62: 2 anni dopo approvazione o interruzione), consenso, IRB |
| Guidance FDA/OHRP sull'eConsent (2016) | G | in vigore | Identità del firmatario, versioni, comprensione, copia al soggetto |
| Guidance *eSource* (2013), *Decentralized Clinical Trials* (finale set 2024), *Digital Health Technologies* (dic 2023) | G | in vigore | Originatore del dato, metadati, raccolta a distanza |
| Guidance *Adaptive Designs* (2019), *Master Protocols* (bozza) | G | in vigore / bozza | Pre-specificazione e firewall delle analisi ad interim |
| Guidance *Data Integrity and Compliance with CGMP* (2018) | G (per analogia) | in vigore | ALCOA, revisione dell'audit trail, accessi amministrativi |
| **Guidance *Computer Software Assurance*** | G | finale set 2025, aggiornata feb 2026 per la QMSR | Validazione proporzionata al rischio, test non scriptati per il basso rischio, uso delle evidenze del fornitore |
| **Bozza *Considerations for the Use of AI to Support Regulatory Decision-Making*** (gen 2025) | G (bozza) | non risulta ancora finale [verificare] | Piano di credibilità in 7 passi per ogni modello AI con impatto su sicurezza del paziente o affidabilità dei risultati |
| **HIPAA** (45 CFR 160/164) | V | in vigore | Se TrialOps tratta PHI per conto di un covered entity: BAA con tutti i fornitori (hosting, AI) |
| FDA Data Standards Catalog + *Study Data Technical Conformance Guide* | V/G | in vigore | SDTM, ADaM e Define-XML obbligatori negli invii NDA/BLA |
| Requisiti federali del contratto ARPA-H (NIST SP 800-171/800-53, eventuale FedRAMP, Section 508) | V (contrattuale) | **[verificare nel bando SOL-26-164]** | Sicurezza dei dati federali e accessibilità |

### 2.3 Unione Europea

| Riferimento | Tipo | Stato | Cosa chiede |
| --- | --- | --- | --- |
| **Regolamento (UE) 536/2014** (CTR) + Reg. di esecuzione 2017/556 (ispezioni GCP) | V | pienamente applicabile dal 31 gen 2025 | CTIS; **art. 58: TMF conservato 25 anni** dopo la fine del trial; art. 57 TMF sempre disponibile e accessibile |
| **EMA *Guideline on computerised systems and electronic data in clinical trials*** (EMA/INS/GCP/112288/2023) | G | in vigore da set 2023 | Il riferimento più dettagliato per TrialOps: revisione periodica dell'audit trail, **controllo dei dati da parte dello sperimentatore**, copie certificate, migrazioni validate, cloud, gestione utenti e sicurezza. Annessi su contratti, validazione, gestione utenti, eCOA, IRT, eConsent |
| Q&A *Complex clinical trials* (CE/EMA/HMA, 2022) | G | in vigore | Trial di piattaforma: gestione dei bracci, firewall, emendamenti |
| EudraLex vol. 4 **Annex 11** (2011) | G (GMP, applicato per analogia nelle ispezioni GCP) | in vigore; **revisione in consultazione (lug–ott 2025), non ancora adottata** | Ciclo di vita, gestione del rischio, fornitore, audit trail, firme, sicurezza |
| EudraLex vol. 4 **Annex 22** (AI) — bozza | G (bozza) | consultazione chiusa, workshop EMA giu–lug 2026, non adottato | Uso previsto, dati di test indipendenti, metriche, controllo dei cambi, supervisione umana |
| **GDPR** (Reg. 2016/679) + parere EDPB 3/2019 sul rapporto CTR–GDPR | V | in vigore | Base giuridica, DPIA, registro dei trattamenti, DPA con i fornitori, trasferimenti extra-UE |
| **AI Act** (Reg. 2024/1689) modificato dall'**AI Omnibus** (in vigore dal 27 lug 2026 [verificare in GU]) | V | Art. 4 (alfabetizzazione AI) già applicabile; **Art. 50 (trasparenza) dal 2 dic 2026**; obblighi alto rischio Annex III dal 2 dic 2027, Annex I dal 2 ago 2028 | Gli agenti di TrialOps non sono di per sé ad alto rischio, ma servono trasparenza sul contenuto generato dall'AI, alfabetizzazione degli utenti e una valutazione documentata per ogni agente |
| **MDR 2017/745** + MDCG 2019-11 | V | in vigore | Solo se una funzione decide sul singolo paziente (rischio "borderline": il pre-screening assistant resta una proposta firmata dal PI, mai una decisione) |
| NIS2 (Dir. 2022/2555), EHDS (Reg. 2025/327) | V | NIS2 recepita; EHDS in applicazione graduale | Sicurezza del fornitore di servizi sanitari; uso secondario dei dati sanitari (riguarda COMMONS e RWD) |

### 2.4 Giappone

| Riferimento | Tipo | Stato | Cosa chiede |
| --- | --- | --- | --- |
| **J-GCP**: Ordinanza MHLW n. 28 del 1997 (医薬品GCP省令) + notifiche di guida | V | **recepimento di ICH E6(R3) previsto entro l'anno fiscale 2026** (apr 2026 – mar 2027) secondo PMDA | Stessi principi di E6(R3); conservazione dei documenti essenziali dello sponsor fino ad almeno 3 anni dopo approvazione o interruzione dello sviluppo [verificare art. 26] |
| **Linea guida ERES**: notifica PFSB n. 0401022 del 1 apr 2005 (電磁的記録・電子署名利用のための指針) | G (equivalente giapponese della Part 11) | in vigore | Autenticità, leggibilità e conservazione dei record elettronici; firme elettroniche; audit trail |
| **Linea guida CSV MHLW**: notifica PFSB/CND n. 1021-11 del 21 ott 2010 (コンピュータ化システム適正管理ガイドライン) | G (nasce per GMP, usata come riferimento GxP) | in vigore | Categorie software in stile GAMP, documenti di sviluppo e validazione, gestione del fornitore |
| Clinical Trials Act (臨床研究法, legge n. 16 del 2017) | V | in vigore | Ricerca clinica non registrativa: registro jRCT, conservazione |
| **APPI** (legge n. 57 del 2003, rev. 2022) | V | in vigore | Dati personali sanitari come "informazioni che richiedono attenzione"; trasferimento all'estero (adeguatezza reciproca UE–Giappone; per gli USA serve consenso o garanzie) |
| PMDA, invio elettronico dei dati di studio (CDISC) | V | obbligatorio dal 1 apr 2020 | SDTM, ADaM e Define-XML come per FDA, con regole di conformità PMDA |
| Notifiche MHLW su DCT ed eConsent | G | **[verificare numero e data]** | Consenso elettronico e visite a distanza |

### 2.5 Cosa ne segue per TrialOps

Le tre giurisdizioni convergono sullo stesso nucleo (ICH E6(R3) + regole sui record elettronici + data integrity).
Conviene quindi costruire **un solo insieme di controlli** e tradurlo in tre matrici di conformità, invece di tre
varianti di prodotto. Le differenze reali sono poche e vanno trattate come configurazione:

- **Conservazione**: 25 anni UE (vincolo dominante) ≥ Giappone ≥ USA → policy di retention per piattaforma, default 25 anni.
- **Residenza dei dati**: UE, USA e, se servirà, Giappone come regioni separate (NFR-06 oggi prevede solo UE e USA).
- **Privacy**: GDPR + HIPAA + APPI → registro dei trattamenti e DPA/BAA per ogni fornitore, base giuridica per regione.
- **Lingua**: J-GCP e PMDA accettano documenti in inglese per molte parti, ma consenso e materiali per i soggetti
  vanno in giapponese → la UI e i documenti per i soggetti devono essere localizzabili (NFR-07 già lo prevede).
- **Firme**: Part 11 è la più prescrittiva (§11.100(c) richiede la certificazione a FDA dell'equivalenza delle firme
  elettroniche). Rispettando la Part 11 si coprono anche Annex 11 ed ERES.

---

## 3. Stato attuale: cosa c'è e cosa manca

Fonte: inventario del codice al commit `45bc4e2` e `docs/SPEC.md` §9–§11. Legenda: ✅ fatto · 🟡 parziale · ❌ mancante.

### 3.1 Audit trail — Part 11 §11.10(e), Annex 11 §9, EMA 2023 §6.2, ERES

| Controllo | Stato | Evidenza / mancanza |
| --- | --- | --- |
| Generato dal sistema, append-only, chi/quando/valore prima e dopo/motivo | ✅ | `core.audit_event` e `core.audit_row()` (migration 0002); motivo obbligatorio sulle tabelle GxP tramite header `X-Change-Reason` |
| Catena di hash e verifica | ✅ | SHA-256 concatenato, `core.audit_verify()` |
| Nessuna cancellazione fisica | ✅ | Trigger `no_delete`, nessun grant DELETE |
| Sigillo crittografico dei blocchi (Ed25519) | 🟡 | Previsto da CMP-01, ma esiste solo come commento: nessun codice firma i blocchi |
| Protezione dagli amministratori del database | 🟡 | I trigger possono essere rimossi dall'owner o da un superuser: serve separare i privilegi e registrare i DDL |
| Copertura completa | ✅ | CMP-15 (0015): ogni tabella auditata o eccezione motivata verificata da test |
| Ora UTC sincronizzata e documentata | 🟡 | `clock_timestamp()` del server DB; manca una dichiarazione documentata su NTP e fuso orario |
| **Revisione dell'audit trail** (EMA 2023, FDA Q&A 2024) | ✅ | CMP-10 (0019): pagina TRO-051, filtri, export CSV e stampa, revisioni firmate con significato *review*; solo QA/admin, mai righe dell'enclave SAC |
| Log degli accessi in lettura ai dati sensibili (enclave SAC, dati non in cieco) | ❌ | Non presente |
| Audit dalle app (`POST /v1/audit-events`, APP-AU-01) | ❌ | Requisito senza test |

### 3.2 Firme elettroniche — Part 11 §11.50, §11.70, §11.100, §11.200, §11.300

| Controllo | Stato | Evidenza / mancanza |
| --- | --- | --- |
| Riautenticazione alla firma, solo una persona può firmare | ✅ | `lib/reauth.ts`, `requirePerson` |
| Significato della firma (autore, revisione, approvazione…) | ✅ | `core.signature.meaning` |
| Legame indissolubile firma ↔ record | ✅ | `target_hash` calcolato dal server, `approval_controls()`, `freeze_approved()` |
| Separazione dei compiti (chi scrive non approva) | ✅ | Migration 0009 |
| **Manifestazione della firma** (nome, data e ora, significato su schermo, stampa ed export, §11.50) | ✅ | CMP-11 (0017): `SignatureManifest` ovunque compaia una firma |
| Motivo salvato sulla firma | ✅ | `core.signature.reason` (0017), obbligatorio su `POST /v1/signatures` |
| Firme in serie nella stessa sessione (§11.200(a)(1)) | ❌ | Non gestite |
| Verifica dell'identità prima di abilitare la firma, lettera di certificazione a FDA (§11.100) | ❌ | Sono procedure, non codice: vanno nelle SOP e nell'onboarding utenti |
| `reauth_mfa` | ✅ | Prodotto dalla firma quando il firmatario ha un autenticatore TOTP (IAM-01) |

### 3.3 Controllo accessi — §11.10(d)(g), §11.300, Annex 11 §12, EMA 2023 Annex 3

| Controllo | Stato | Evidenza / mancanza |
| --- | --- | --- |
| Account univoci, ruoli con perimetro piattaforma/braccio/sito, RLS guidata dai claim | ✅ | `core.role_assignment`, hook 0008, RLS |
| Agenti e app sempre "in cieco" | ✅ | `auth.ts` |
| Signup disabilitato, password di almeno 10 caratteri | ✅ | `docs/supabase.md` |
| **MFA** | ✅ | IAM-01 (2026-10-10): TOTP Supabase obbligatorio per ogni persona con un ruolo (token `aal2`, policy in `lib/access-policy.ts`); firma con password + codice (`reauth_mfa`); esenzione solo demo documentata in `docs/supabase.md` |
| **Timeout di sessione, blocco dopo tentativi falliti** | ✅ | CMP-03 (0018): timeout di inattività lato server per `session_id` (15 min) e nel browser; blocco dopo 5 errori in 15 min (login, codice, ri-autenticazione di firma), sblocco solo da admin con motivo; tutto in `core.auth_event` e nell'audit trail |
| Revisione periodica degli accessi (IAM-06), provisioning SCIM, SSO aziendale | ❌ | Non presenti |
| RLS su `person` e `role_assignment` | ❌ | Assente |

### 3.4 Integrità, conservazione e disponibilità dei dati

| Controllo | Stato | Evidenza / mancanza |
| --- | --- | --- |
| Versioni immutabili, `void` al posto della cancellazione, macchine a stati nel database | ✅ | 0003, 0005, 0010 |
| Hash delle versioni dei documenti | ✅ | `document_version.sha256` |
| Concorrenza ottimistica (`If-Match`), idempotenza (APP-DT-02) | ❌ | `row_version` viene solo mostrato |
| Provenienza del dato (`source_app`, `transformation_id`, APP-DT-05) | ❌ | Non presente |
| Blocco dei dati, data freeze (EDC-08) | ❌ | Non presente |
| **Backup, PITR, test di restore, retention di 25 anni, archivio** | 🟡 | NFR-04: retention per piattaforma (0016), test di restore con evidenza (`BACKUP_RESTORE.md`), backup giornalieri Supabase; PITR e archivio WORM rimandati al primo trial reale (decisione 2026-10-10) |
| **Copie certificate ed export leggibile** dell'intero record con audit e firme | ❌ | Non presente |
| Archivio documenti immutabile (WORM) | ❌ | Non c'è ancora un archivio file |
| Accesso indipendente dello sperimentatore ai dati del proprio sito (EMA 2023 §4.6) | ❌ | Da progettare insieme all'EDC (M06b) |

### 3.5 Validazione e processo — GAMP 5, CSA, Annex 11 §4, EMA 2023 Annex 2

| Controllo | Stato | Evidenza / mancanza |
| --- | --- | --- |
| Requisiti con ID, test etichettati, matrice di tracciabilità generata, gate in CI | ✅ | `requirements.json`, `scripts/trace.mjs`, `npm run verify`, CI che carica le evidenze |
| Requisiti con classe di rischio e impatto GxP | ❌ | `requirements.json` ha solo `id`, `release` e `text` |
| Requisiti della spec non tracciati | ❌ | CMP-03, CMP-05…09, IAM-01, IAM-06, VAL-01…04, NFR-04/05 non sono nel file |
| Piano di validazione, risk assessment per funzione, URS/FS/DS, IQ/OQ | ❌ | Non presenti |
| Change control, release note, tag di versione, evidenze CI firmate | ❌ | Non presenti |
| Promozione dev → test → prod con approvazione (VAL-02) | ❌ | Il deploy è manuale da CLI |
| Revisione umana del codice e branch protetto | ❌ | Il codice è scritto da Claude e da Local Dev; serve una revisione umana documentata |
| SAST, scansione delle dipendenze, SBOM, penetration test | ❌ | Non presenti |
| Qualifica dei fornitori (Supabase, Netlify, Anthropic, GitHub) | ❌ | Non presente; la spec prevede Azure, il demo gira su Supabase e Netlify |
| QMS del fornitore (SOP, formazione, QA indipendente) | ❌ | Non presente |

### 3.6 AI — bozza FDA AI 2025, principi FDA–EMA 2026, Annex 22 (bozza), AI Act, GAMP AI

| Controllo | Stato | Evidenza / mancanza |
| --- | --- | --- |
| Gateway unico, registro dei task type con uso previsto, rischio, prompt versionato e JSON Schema | ✅ | `services/ai-runtime` |
| Classi di dati e provider ammessi | ✅ | `STRICT_LOCAL` rifiutato da Anthropic |
| Ledger immutabile con hash di input e output, costo, revisore, decisione | ✅ | `core.ai_request` |
| Proposta firmata da una persona per gli output GxP | ✅ | `task_fsm`, revisione dei task |
| **Versione del modello bloccata** | 🟡 | `MODEL = 'claude-opus-5-5'` è un alias, non uno snapshot datato: per AI-03 serve un identificativo immutabile e una change request quando cambia |
| Parametri fissi (AI-04), tool registry AUTO/CONFIRM/BLOCK (AI-07), Agent Decision Record scritto (AI-08), limiti per job (AI-09) | 🟡/❌ | La tabella dell'Agent Decision Record esiste, ma nessuno la scrive; AI-09 è coperto solo in parte |
| **Piano e report di credibilità per task type** (FDA, 7 passi) | ❌ | Non presente |
| Monitoraggio di deriva e prestazioni (AI-10) | ❌ | Non presente |
| Marcatura persistente "generato da AI" sul contenuto accettato (AI Act art. 50, ricostruibilità) | ✅ | CMP-09 (0017): `ai_provenance` immutabile sulla versione dell'appendice, badge `AiProvenance` |
| Fornitore AI: DPA, BAA, zero retention, regione | ❌ | La chiave attuale è quella del sito Grant OS; nessuna qualifica documentata |

### 3.7 Funzioni cliniche con requisiti regolatori specifici

Non ancora sviluppate, ma ognuna ha requisiti propri che vanno scritti **prima** di svilupparla:

- **IRT / randomizzazione** (EMA 2023 Annex IRT): algoritmo validato, lista di randomizzazione protetta, log
  dell'unblinding di emergenza con motivo e notifica.
- **Unblinding**: workflow con doppia autorizzazione e log degli accessi in lettura.
- **eConsent** (21 CFR 50.27, guidance FDA/OHRP, EMA 2023 Annex eConsent, MHLW): verifica dell'identità, versione
  approvata dall'IRB, copia al soggetto, firme Part 11.
- **Safety**: E2B(R3), MedDRA come dizionario con versione controllata (oggi è testo libero), clock 7/15 giorni già presente.
- **EDC (M06b)**: CDASH, edit check validati, query, firma del PI per CRF, controllo dei dati da parte dello
  sperimentatore, export ODM/SDTM con Define-XML, data lock.
- **eTMF**: modello di riferimento TMF, QC, archiviazione per 25 anni, copie certificate.

---

## 4. Come riportare lo sviluppo a "GCP by design"

L'impostazione attuale è buona. Audit trail con catena di hash, firme legate al record, macchine a stati nel database,
proposte AI firmate e tracciabilità in CI sono già più di quanto hanno molti prodotti commerciali. Le lacune sono
soprattutto di **processo** (rischio, documentazione, change control, QMS) e di alcuni **controlli di sicurezza**
(MFA, sessione, revisione dell'audit trail, backup). Le proposte sono in ordine di impatto.

### 4.1 Requisiti con rischio e riferimenti normativi (fondamento di tutto il resto)

Estendere lo schema di `docs/requirements.json` con questi campi:

```json
{
  "id": "CMP-03",
  "release": "v1",
  "text": "MFA, session timeout, lockout after failed attempts, periodic access review",
  "gxp_impact": "direct",            // direct | indirect | none
  "risk": "high",                    // high | medium | low  (patient safety × data integrity × regulatory decision)
  "assurance": "scripted",           // scripted | unscripted | automated-only  (FDA CSA)
  "regs": ["21CFR11.10(d)", "21CFR11.300", "EU-A11-12", "EMA-CSDE-2023-A3", "JP-ERES-3.2"]
}
```

Poi:

- `scripts/trace.mjs` genera, oltre alla matrice attuale, **una matrice di conformità per norma** (Part 11,
  Annex 11, EMA 2023, ERES, E6(R3) §4.3) partendo da un file `docs/compliance/crosswalk.json` (clausola →
  requisiti). Ogni clausola senza requisito, o con requisito senza test, è un gap visibile.
- Il gate CI fallisce se un requisito `risk: high` non ha un test `scripted` con evidenza, se un requisito
  `gxp_impact: direct` non ha `regs`, o se un requisito della spec manca dal file.
- Si aggiungono subito i requisiti oggi non tracciati: CMP-03, CMP-05…09, IAM-01, IAM-06, VAL-01…04, NFR-04, NFR-05.

### 4.2 Regole nuove per il motore di sviluppo (`CLAUDE.md` del repo)

Da aggiungere alle "Non-negotiable rules":

9. **Ogni nuova funzione nasce con la classe di rischio.** Prima del codice: requisito con `gxp_impact`, `risk`,
   `regs`. Una funzione `high` richiede un test scriptato e una revisione umana prima del merge.
10. **Ogni nuova tabella o transizione di stato è auditata.** Niente tabelle GxP senza `attach_std`, niente stati
    cambiati fuori dalla macchina a stati. Un test generico verifica che ogni tabella dello schema `core` abbia il
    trigger di audit o sia nell'elenco motivato delle eccezioni.
11. **Il tempo è sempre UTC del server.** Mai timestamp dal client nei record GxP; la UI mostra il fuso orario.
12. **Ogni task type AI GxP ha un piano di credibilità** (`docs/ai/<task_type>.md`: contesto d'uso, influenza del
    modello, conseguenza della decisione, dataset di test, metriche e soglie) prima di essere registrato.
13. **Nessun dizionario o terminologia clinica in testo libero** (MedDRA, WHODrug, CDISC CT): tabelle con versione.
14. **Ogni export di un record GxP include audit trail e manifestazione delle firme.**

### 4.3 Controlli tecnici da completare (backlog proposto)

| Pri | ID proposto | Lavoro | Norme |
| --- | --- | --- | --- |
| P0 | CMP-03 / IAM-01 | MFA (TOTP o passkey) obbligatoria per i ruoli con firma; timeout di inattività; blocco dopo N tentativi falliti; `reauth_mfa` sulla firma | §11.10(d), §11.300, Annex 11 §12, EMA 2023 A3 |
| P0 | CMP-10 (nuovo) | **Consultazione dell'audit trail** per i ruoli QA/ispettore: filtri per record, utente e periodo; export PDF e CSV leggibile; registro delle revisioni fatte | §11.10(b)(e), EMA 2023 §6.2, PIC/S PI 041 |
| P0 | CMP-11 (nuovo) | **Manifestazione della firma** su schermo, stampa ed export (nome, data/ora UTC, significato); motivo salvato in `core.signature` | §11.50, §11.70 |
| P0 | NFR-04 | Backup con PITR, test di restore documentato, policy di retention per piattaforma (default 25 anni), archiviazione | CTR art. 58, §11.10(c), Annex 11 §7 |
| P1 | CMP-01b | Sigillo Ed25519 periodico dei blocchi di audit con ancoraggio esterno (es. hash pubblicato in un archivio immutabile); event trigger su DDL; ruoli di amministrazione DB separati e monitorati | §11.10(e), PIC/S |
| P1 | CMP-12 (nuovo) | Log degli accessi in lettura per enclave SAC, dati non in cieco ed export | EMA 2023, ICH E6(R3) |
| P1 | CMP-13 (nuovo) | Copie certificate: export di un record o di un intero trial (dati + audit + firme + hash) in formato aperto | §11.10(b), EMA 2023 §4.8 |
| P1 | APP-DT-02/05 | `If-Match`, idempotenza, provenienza del dato | ALCOA+ |
| P1 | AI-03/04 | Snapshot del modello bloccato, parametri fissi, change request al cambio di modello con regressione sul dataset di test | Bozza FDA AI, Annex 22 (bozza), GAMP AI |
| P1 | AI-08/10 | Agent Decision Record scritto davvero; monitoraggio di accettazione e deriva con ritorno automatico a "solo suggerimento" | Principi FDA–EMA 2026 |
| P1 | CMP-09 | Etichetta persistente "contenuto generato dall'AI, revisionato da X" sul contenuto accettato | AI Act art. 50 (dal 2 dic 2026) |
| P2 | IAM-06, APP-ID-03 | Revisione periodica degli accessi con firma; SCIM; SSO aziendale | §11.10(d), Annex 11 §12 |
| P2 | NFR-05 | SAST, scansione delle dipendenze, SBOM in CI; penetration test prima della produzione | Annex 11 §12, EMA 2023 A4, NIS2 |
| P2 | NFR-06 | Regioni separate UE/USA (e Giappone su richiesta) | GDPR, HIPAA, APPI |

### 4.4 Processo di sviluppo e qualità (GAMP 5 2ª ed. + CSA)

1. **Classificazione GAMP.** Il core TrialOps è **categoria 5** (sviluppo custom) per IST; per i clienti va
   presentato come **prodotto configurabile (categoria 4)**, con configurazione (Master Protocol, ruoli, policy)
   separata dal codice e versionata. Le app verticali dichiarano già `gamp_category` nel manifest.
2. **Pacchetto di validazione generato a ogni release** (la spec §10 lo prevede, ora va costruito):
   - piano di validazione (documento unico, aggiornato per release);
   - risk assessment per funzione, generato da `requirements.json`;
   - matrice di tracciabilità e matrici di conformità per norma;
   - evidenze dei test (JUnit + screenshot Playwright) con hash e **firma della release dentro TrialOps stesso**
     (dogfooding: il rilascio è un record firmato con significato "approval" da QA);
   - **IQ automatico**: script post-deploy che verifica versione, migration applicate, `audit_verify()`,
     configurazione di sicurezza (401 da anonimo, signup off, MFA attiva) e salva l'esito;
   - **OQ**: la suite automatica + test scriptati per le funzioni `high`;
   - **PQ**: modelli che il cliente esegue nel suo ambiente.
3. **Change control.** Ogni release ha un tag `vX.Y.Z`, release note con impatto sui requisiti, valutazione del
   rischio delle modifiche e approvazione QA. Promozione dev → test → prod solo da pipeline (VAL-02): niente
   `netlify deploy --prod` da CLI per un ambiente GxP.
4. **Sviluppo assistito dall'AI.** Il codice scritto da Claude Code e Local Dev è accettabile in GxP se la
   **revisione umana è documentata** (pull request approvata da una persona diversa dall'autore, branch protetto) e
   se gli strumenti di sviluppo sono descritti nel QMS come strumenti, con il loro controllo. Da verificare che `main` di
   `luca-emili-ist/trialops` abbia la branch protection davvero applicata (sui repo privati di account personali
   GitHub non la applica); se no, spostarlo in un'organizzazione con un piano adeguato.
5. **Qualifica dei fornitori.** Una scheda per fornitore critico (Supabase, Netlify o Azure, Anthropic, GitHub):
   certificazioni (SOC 2, ISO 27001), DPA/BAA, regione, backup, uscita dal servizio, notifica degli incidenti.
   Va presa la decisione Supabase/Netlify contro Azure (spec §11) prima della prima release GxP, perché cambia IQ e
   qualifica.
6. **QMS minimo di IST per il software** (prerequisito dell'audit dei clienti): SOP su ciclo di vita, change control,
   gestione di incidenti, deviazioni e CAPA, backup e restore, gestione accessi, gestione fornitori, formazione GCP e
   Part 11 del personale, controllo documentale, ciclo di vita dei modelli AI. Una persona QA indipendente dallo
   sviluppo approva le release.

### 4.5 Percorso verso il "certificato"

| Fase | Quando | Risultato |
| --- | --- | --- |
| A. Controlli P0 + requisiti estesi + crosswalk | prima della v1 (inizio EDC) | Gap tecnici critici chiusi, conformità misurabile in CI |
| B. QMS minimo + pacchetto di validazione automatico + qualifica fornitori | in parallelo alla v1 | Release "validation-ready" difendibili in un supplier audit |
| C. Assessment indipendente Part 11 / Annex 11 / EMA 2023 / ERES di una società GxP esterna | prima del primo uso in un trial reale | Report di terza parte da dare ai clienti e allegare alla proposta |
| D. ISO 27001 + SOC 2 Type II; ISO 9001 (o 13485) del processo software; eventuale ISO 42001 | 12–18 mesi | Certificazioni dell'organizzazione |
| E. Primo cliente: PQ nel suo ambiente, con i nostri modelli | al go-live | Sistema validato per l'uso previsto, cioè utilizzabile in GCP |

---

## 5. Decisioni (Luca, 2026-10-10)

| # | Tema | Decisione | Effetto |
| --- | --- | --- | --- |
| 1 | Profilo di conformità dei requisiti e regole 9–15 | Approvato | `requirements.json` esteso, `crosswalk.json`, matrice `compliance-matrix.md` generata da `npm run trace`, regole nel `CLAUDE.md` del repo |
| 2 | Quando fare i P0 | Subito, in parallelo alla demo del 4 novembre | Release `gxp-p0`: IAM-01, CMP-03, CMP-09, CMP-10, CMP-11, CMP-15, NFR-04, VAL-05 |
| 3 | Hosting della prima release GxP | Supabase per ora | Qualifica di Supabase (e Netlify) come fornitori; PITR e backup su Supabase |
| 4 | QA indipendente | In stand-by | Le release restano "validation-ready" ma non approvate da QA finché non si nomina |
| 5 | Giappone | Nel perimetro da subito | Regione dati JP (NFR-06), giapponese per pagine di sito e soggetto (NFR-07), APPI |
| 6 | Assessment esterno | Sì | Shortlist in `ASSESSMENT_VENDORS.md`; contatto a cura di Luca |
| 7 | PITR Supabase | Rimandato al primo trial reale | Oggi backup giornalieri (RPO 24 h) |
| 8 | Archivio WORM 25 anni | Da decidere più avanti | Requisiti in `BACKUP_RESTORE.md` §3.3 |
| 9 | Progetto dati Giappone | Più avanti; prima codice multi-regione e localizzazione | NFR-06/NFR-07 (v1) |

**Stato al 2026-10-10:** release `gxp-p0` 8/8 nei test (IAM-01, CMP-03, CMP-09, CMP-10, CMP-11, CMP-15, NFR-04, VAL-05).

## Fonti principali

- ICH E6(R3) consolidata e Annex 2 (ICH, giu 2026); pagina EMA ICH E6 (Annex 2 in vigore dal 15 gen 2027).
- FDA, *Electronic Systems, Electronic Records, and Electronic Signatures in Clinical Investigations: Q&A* (ott 2024).
- FDA, *Computer Software Assurance for Production and Quality System Software* (set 2025, agg. feb 2026).
- FDA, bozza *Considerations for the Use of AI to Support Regulatory Decision-Making* (gen 2025); FDA–EMA,
  *Guiding Principles of Good AI Practice in Drug Development* (gen 2026).
- EMA, *Guideline on computerised systems and electronic data in clinical trials* (2023).
- Commissione UE, consultazione su EudraLex vol. 4 Cap. 4, Annex 11, Annex 22 (lug–ott 2025).
- Reg. (UE) 2024/1689 (AI Act) e AI Omnibus 2026.
- PMDA, piano di recepimento di ICH E6(R3) nel J-GCP entro l'anno fiscale 2026.
