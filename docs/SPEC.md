# Specifiche di sviluppo — Piattaforma TA3 Clinical Operations (demo-ready)

Oct 6, 2026 · @Luca emili

## 1. Scopo, perimetro e principi

Questo documento è la specifica da passare al motore di sviluppo per costruire **TrialOps** (nome di lavoro). TrialOps è una piattaforma di clinical operations per trial di piattaforma adattivi, con cui InSilicoTrials si propone come fornitore TA3 nel bando ARPA-H SURPASS. Obiettivo immediato: un ambiente dimostrabile, costruito riusando Grant OS (InSilicoTrials OS), ist-clinical-platform e l'AI Gateway già specificato.

**Perimetro**

- Agnostica rispetto alla malattia: nessuna logica clinica cablata; area terapeutica, endpoint e visite sono configurazione del Master Protocol.
- Copre le attività TA3 a–w del bando (operations, documenti, siti, regolatorio, dati, safety, supply, qualità, finanza, metriche).
- Non sostituisce per forza EDC, IRT, eTMF o safety database esistenti: li orchestra. Ogni componente può essere un modulo nativo o un'**app verticale** installata che dialoga via API (dati, task, utenti).
- TA1 (simulazione) e TA2 (inferenza) sono app verticali collegate, non parte del core. Il motore di simulazione IST è la prima app TA1.

**Principi di progetto (vincolanti per lo sviluppo)**

1. **Piattaforma → braccio → stadio** è la gerarchia di ogni oggetto. Nessuna entità clinica esiste fuori da questa gerarchia.
2. **API-first e event-driven:** ogni funzione del core è esposta via API documentata (OpenAPI 3.1) ed emette eventi; la UI usa le stesse API delle app.
3. **I fatti e le previsioni non stanno mai nella stessa riga** (principio del Registro Costi di Grant OS), esteso a tutto: arruolamento reale vs previsto, costo reale vs budget, tempi reali vs target.
4. **Ogni azione AI è una proposta finché una persona non la firma**, se tocca dati o documenti GxP. L'AI non prende decisioni assegnate a sponsor, investigatori, SAC, DSMB, IRB o regolatori.
5. **Validation-ready by design:** requisiti tracciati, test automatici come evidenza, audit trail immodificabile, niente modifiche in produzione fuori dalla pipeline dev → test → prod.
6. **Demo prima, ma senza scorciatoie strutturali:** la demo usa dati sintetici e può avere moduli parziali. Il modello dati, l'audit trail, i permessi e il contratto delle app sono quelli definitivi.

**Lettori del documento:** il motore di sviluppo (Claude Code / Forge / Local Dev), il product owner (Luca Emili) e il responsabile qualità CSV. Ogni requisito ha un ID (es. `APP-ID-03`) da usare nella matrice di tracciabilità.

## 2. Riuso di Grant OS e dei lavori già fatti

Circa metà della piattaforma esiste già in forma riusabile: shell multi-modulo, accesso per modulo con RLS, finanza, governance, AI con chiavi lato server, pipeline di validazione. Il lavoro nuovo è il dominio clinico, il contratto delle app verticali e il controllo GxP dell'AI.

| Asset esistente | Cosa contiene oggi | Come si riusa in TrialOps | Intervento |
| --- | --- | --- | --- |
| [Grant OS / InSilicoTrials OS](https://drive.google.com/file/d/1V1ApY9EylSCWS9fFZ19tZx3nNg22ofv0/view) – shell | SPA React, moduli abilitati per utente (`user_has_module`), audit\_log, allegati, admin panel | Shell, menu moduli, pannello admin, registro moduli diventa registro app | Migrare a TypeScript + Vite; il registro moduli diventa il catalogo delle app installate |
| Grant OS – dati | PostgreSQL + PostgREST, 43 tabelle con schema uniforme `{id, data jsonb, updated_at}`, RLS | Stesso stack | **Cambio necessario:** le entità cliniche GxP usano tabelle tipizzate con vincoli e audit trigger; `jsonb` resta solo per configurazione ed estensioni delle app |
| Grant OS – migrazione Azure (luglio 2026) | Piano Supabase → Azure VM: Postgres 16, PostgREST 12, Entra ID + MSAL, Azure Blob, Express api-server | Base infrastrutturale | Completare la migrazione prima di iniziare; aggiungere un IdP per utenti esterni (siti, sponsor) |
| Grant OS – Finance | 15 tabelle `fin_*`: costi, milestone, rischi, funding events, scenari di piano | Modulo economico-finanziario per braccio e piattaforma | Aggiungere dimensioni piattaforma/braccio/sito/sponsor e chiavi di ripartizione |
| [Registro Costi (FIN-021)](https://drive.google.com/file/d/1CegFxGhe-IKQUgXUcojXFUiuzWgqywkx/view) | Regole: fatti separati da previsioni, chiave fornitore deterministica, mese provvisorio, 10 verifiche prima del caricamento | Regole di import per fatture CRO, vendor, siti | Riuso diretto delle regole come requisiti FIN |
| Grant OS – Governance | 8 tabelle `gov_*`: organi, verbali, adempimenti, documenti | Governance di piattaforma: comitati, diritti decisionali, verbali, escalation | Rimodellare su organi del trial (Steering, SAC, DSMB) |
| Grant OS – Grants | Gestione bandi, partner, task, workspace | Gestione dell'OT ARPA-H: milestone, deliverable, cost share | Riuso quasi diretto |
| [AI Gateway spec v1](https://drive.google.com/file/d/1r4lHyMJdBlEZO0YqKEsH1QabrLuFQg0e/view) e [analisi](https://drive.google.com/file/d/1kXkG64zvno34qhI-BqndjGyf_uSuxQ0b/view) | Gateway unico, intenti invece di modelli, adapter per provider, tier, quality gate, `privacy_level`, tool registry AUTO/CONFIRM/BLOCK, libro mastro dei costi | AI layer di TrialOps | Aggiungere classi di dati GxP, allowlist di modelli validati, versioni bloccate, firma umana |
| [Deontos](https://drive.google.com/file/d/1aQ-MOK1x3v7GmPNAG6IF6jGCWL-mnRPJ/view) | Controllo deterministico delle azioni degli agenti (ALLOW/REVIEW/BLOCK), Agent Decision Record firmato Ed25519, 66 policy da Good AI Practice FDA/EMA, AI Act, GDPR | Strato di controllo degli agenti TA3 | Integrare come policy decision point; serve accordo tra le due società |
| ist-clinical-platform (Increment 1) | Livello V&V GAMP 5 / CSA: pgTAP, Vitest, CI, matrice di tracciabilità; ambienti dev/test/prod | Pipeline di validazione di TrialOps | Riuso diretto; estendere la matrice ai requisiti di questo documento |
| Forge / Local Dev | Fabbrica di sviluppo con AI locale (Qwen/Gemma via Ollama), quality gate `lint && build && test`, Enterprise Base (Extension Layer Brief) | Motore di sviluppo e base per l'SDK delle app | Allineare l'Enterprise Base al contratto delle app (sezione 4) |
| Analisi SURPASS (sessione "Tecnologia ISO da sviluppare" e documento precedente) | Mappatura TA3 a–w su EDC/CTMS/eTMF/IRT, strategia open core, gap analysis | Requisiti funzionali e priorità | Già incorporata nelle sezioni 7–12 |

**Rischio di sequenza, già segnalato nell'analisi del gateway:** Forge ha tre parti specificate e nessuna fusa in produzione. TrialOps non deve aggiungere un quarto cantiere a metà: va costruito come estensione di Grant OS migrato, con il gateway AI estratto da ciò che già funziona.

## 3. Architettura di sistema

TrialOps è un core di moduli nativi più un catalogo di app verticali installabili. Tutto passa da un unico API Gateway con identity broker: le app non accedono mai direttamente al database del core.

&#91;embedded content: architettura TrialOps · core, app verticali, AI layer\]

Moduli nativi e app verticali sono intercambiabili: un dominio (per esempio EDC) può essere servito da un modulo nativo o da un'app esterna che implementa lo stesso contratto.

**Componenti tecnici**

| ID | Componente | Responsabilità | Tecnologia di riferimento |
| --- | --- | --- | --- |
| ARC-01 | Web shell | UI unica, menu da registro app, inbox dei task, ricerca globale, switch piattaforma/braccio | React 18 + TypeScript + Vite (evoluzione della shell Grant OS) |
| ARC-02 | API Gateway | Routing, OAuth2/OIDC, rate limiting, versioning `/v1`, idempotenza, logging | Nginx o Azure API Management davanti a Platform API e PostgREST |
| ARC-03 | Platform API | Logica di dominio, validazioni, workflow, eventi; OpenAPI 3.1 generata dal codice | Node.js + TypeScript (NestJS o Express strutturato), evoluzione dell'api-server Grant OS |
| ARC-04 | Data store | Dati di dominio tipizzati, RLS, audit trigger | PostgreSQL 16; PostgREST solo per letture e tabelle di configurazione |
| ARC-05 | Event bus | Eventi di dominio con pattern outbox, consegna almeno una volta, replay | Tabella outbox + NATS JetStream o Azure Service Bus; formato CloudEvents 1.0 |
| ARC-06 | Task e workflow engine | Task umani e di sistema, assegnazione, SLA, escalation, delega alle app | Motore interno su Postgres per la demo; Temporal valutabile dopo |
| ARC-07 | Audit ledger e firme | Audit trail append-only con catena di hash e firma; servizio di firma elettronica Part 11 | Postgres + firma Ed25519 (stesso schema degli Agent Decision Record di Deontos) |
| ARC-08 | Document store | File del TMF e documenti controllati, versioni, immutabilità | Azure Blob con versioning e policy WORM per i documenti approvati |
| ARC-09 | Identity broker | SSO per utenti interni ed esterni, federazione con IdP di siti e sponsor, provisioning SCIM verso le app | Entra ID (interni) + Entra External ID o Keycloak (esterni) |
| ARC-10 | AI Runtime | AI Gateway, Voice Gateway, tool registry, libro mastro AI | Servizio autonomo `ai-runtime` (come da analisi del 13 settembre) |
| ARC-11 | Data backbone | Import/export standard e lineage | CDISC ODM / Dataset-JSON / SDTM, HL7 FHIR R4 (HAPI FHIR), USDM per il protocollo |
| ARC-12 | App runtime | Esecuzione delle app ospitate in container isolati, oppure app esterne registrate via URL | Azure Container Apps; micro-frontend via Module Federation o iframe sandbox |

**Ambienti:** dev, test, demo e prod separati, con promozione solo via pipeline (già in uso per ist-clinical-platform). L'ambiente demo contiene esclusivamente dati sintetici. Per SURPASS serve un deployment con dati in USA; il codice deve supportare più regioni con la stessa configurazione.

## 4. Contratto di integrazione delle app verticali

Un'app verticale è un software (di IST o di terzi) che gestisce un dominio, per esempio EDC, eConsent, IRT, simulazione TA1 o analisi TA2. Si installa dal catalogo e dialoga con il core solo tramite tre contratti: **identità e utenti**, **dati**, **task**. Un quarto contratto, **audit**, è obbligatorio per le app che trattano dati GxP.

### 4.1 Manifest dell'app

Ogni app dichiara cosa fa, cosa legge, cosa scrive e quali task sa eseguire. L'installazione avviene solo se un amministratore approva gli scope richiesti.

```json
{
  "app_id": "ist.simulation-ta1",
  "version": "1.4.0",
  "publisher": "InSilicoTrials Technologies",
  "gxp_class": "L2",
  "gamp_category": 4,
  "hosting": "external",
  "base_url": "https://sim.insilicotrials.com",
  "auth": { "oidc_redirect_uris": ["https://sim.insilicotrials.com/callback"], "scim": true },
  "scopes": ["platform:read", "arm:read", "enrollment.metrics:read", "simulation.results:write"],
  "domains": ["simulation"],
  "roles": ["sim.viewer", "sim.designer", "sim.approver"],
  "events": {
    "subscribe": ["arm.created", "enrollment.snapshot.published"],
    "publish": ["simulation.run.completed"]
  },
  "task_types": ["simulation.rerun", "simulation.scenario.review"],
  "ui_extensions": [{ "slot": "arm.detail.tab", "title": "Simulazione", "url": "/embed/arm/{arm_id}" }],
  "data_residency": ["EU", "US"],
  "validation_package_url": "https://.../vp-1.4.0.zip"
}
```

| ID | Requisito |
| --- | --- |
| APP-MF-01 | Il manifest è validato contro uno JSON Schema pubblicato; un manifest non valido blocca l'installazione |
| APP-MF-02 | Ogni cambio di versione che aggiunge scope richiede nuova approvazione; i cambi di patch no |
| APP-MF-03 | Il catalogo mostra per ogni app: publisher, classe GxP, scope, residenza dati, stato del pacchetto di validazione |
| APP-MF-04 | Disinstallare un'app revoca token e scope entro 60 secondi e conserva i dati già scritti nel core |

### 4.2 Classi di app

| Classe | Cosa può fare | Requisiti minimi |
| --- | --- | --- |
| L0 – Utility | Nessun dato GxP (es. calendario, chat) | Manifest, SSO |
| L1 – Lettura GxP | Legge dati GxP, non li modifica (es. dashboard, simulazione su dati in cieco) | + log degli accessi, residenza dati dichiarata |
| L2 – Scrittura derivata | Scrive risultati derivati, mai dati sorgente (es. risultati di simulazione, report) | + audit verso il core, pacchetto di validazione del fornitore |
| L3 – Sistema di record GxP | È la fonte primaria di un dominio GxP (es. EDC, IRT, safety database) | + Part 11 propria, audit trail esportabile, qualifica del fornitore, test di integrazione nella pipeline di TrialOps |

### 4.3 Contratto identità e utenti

| ID | Requisito |
| --- | --- |
| APP-ID-01 | SSO via OpenID Connect: TrialOps (identity broker) è l'unico IdP verso le app. Le app non gestiscono password |
| APP-ID-02 | Il token di accesso contiene claim standard (`sub`, `email`, `org_id`) e claim TrialOps: `platform_ids`, `arm_scopes` (lista di bracci visibili), `roles` (ruoli dell'app assegnati), `blinding` (`blinded` / `unblinded`) |
| APP-ID-03 | Provisioning utenti verso le app via SCIM 2.0 (create, update, deactivate). Disattivare un utente in TrialOps lo disattiva in tutte le app entro 5 minuti |
| APP-ID-04 | I ruoli delle app sono dichiarati nel manifest e assegnati in TrialOps. L'app non può assegnare ruoli in autonomia |
| APP-ID-05 | Per chiamate tra servizi, OAuth2 client credentials con token di breve durata (≤ 15 minuti) e scope minimi |
| APP-ID-06 | La firma elettronica Part 11 è un servizio del core: l'app chiede una firma (`POST /v1/signatures`), l'utente si riautentica nella UI di TrialOps, l'app riceve l'esito firmato |

### 4.4 Contratto dati

| ID | Requisito |
| --- | --- |
| APP-DT-01 | API REST versionate (`/v1/...`) descritte in OpenAPI 3.1; ogni risorsa ha `id`, `version`, `created_at`, `updated_at`, `platform_id`, `arm_id` dove applicabile |
| APP-DT-02 | Scritture con header `Idempotency-Key` obbligatorio; concorrenza ottimistica con `If-Match` sulla versione |
| APP-DT-03 | Formati standard per i domini clinici: FHIR R4 per pazienti e dati da EHR; CDISC ODM / Dataset-JSON per dati EDC; USDM per il protocollo; E2B(R3) per i casi di safety |
| APP-DT-04 | Eventi di dominio pubblicati in formato CloudEvents 1.0 sul bus e via webhook firmati HMAC-SHA256, con retry esponenziale e replay fino a 7 giorni |
| APP-DT-05 | Ogni dato scritto da un'app porta la provenienza: `source_app`, `source_record_id`, `source_version`, `transformation_id` (requisito SURPASS su lineage verso TA1/TA2) |
| APP-DT-06 | Le app L1–L2 ricevono solo i dati nei loro scope e nei bracci di `arm_scopes`; i dati non in cieco solo se l'utente o il client ha `blinding=unblinded` |
| APP-DT-07 | Esportazione massiva asincrona (`POST /v1/exports` → job → file firmato) per dataset analitici; nessun accesso diretto al database |

**Catalogo eventi minimo (v1):** `platform.protocol.version.approved`, `arm.created`, `arm.stage.changed`, `arm.closed`, `site.activated`, `subject.prescreened`, `subject.consented`, `subject.randomized`, `visit.completed`, `ae.reported`, `sae.reported`, `deviation.detected`, `document.filed`, `submission.status.changed`, `contract.executed`, `irb.approved`, `enrollment.snapshot.published`, `adaptation.decision.recorded`, `task.created`, `task.completed`, `cost.recorded`.

### 4.5 Contratto task (delega di attività)

Il task è l'unità di lavoro condivisa tra persone, agenti AI e app. Il core è il proprietario di ogni task: un'app può eseguirlo, ma lo stato vive in TrialOps.

| ID | Requisito |
| --- | --- |
| APP-TK-01 | Un task ha: `type`, `subject_ref` (oggetto a cui si riferisce), `assignee` (persona, ruolo, agente o app), `due_at`, `priority`, `gxp_impact` (sì/no), `inputs`, `outputs`, `requires_signature` |
| APP-TK-02 | Stati: `created → assigned → in_progress → (waiting_review) → completed / rejected / cancelled / expired`; ogni transizione è un evento e una riga di audit |
| APP-TK-03 | Un'app riceve i task dei `task_types` del suo manifest via webhook o long-poll (`GET /v1/tasks?type=...&status=assigned`), li prende in carico (`POST /v1/tasks/{id}/claim`) e li chiude con gli output |
| APP-TK-04 | Un task con `gxp_impact=true` eseguito da un'app o da un agente passa sempre per `waiting_review` e si chiude solo con firma di una persona autorizzata |
| APP-TK-05 | SLA ed escalation configurabili per tipo di task: promemoria, riassegnazione al ruolo superiore, segnalazione nel cruscotto metriche |
| APP-TK-06 | Le app possono creare task per persone (es. "rivedere scenario di simulazione"): compaiono nell'inbox unica della shell |
| APP-TK-07 | Il tempo di ogni task è registrato (creazione, presa in carico, chiusura) e alimenta la metrica SURPASS delle ore-uomo |

### 4.6 Contratto audit

| ID | Requisito |
| --- | --- |
| APP-AU-01 | Le app L2 e L3 inviano al core un evento di audit per ogni creazione, modifica o cancellazione di dati GxP (`POST /v1/audit-events`): chi, cosa, quando, valore precedente, valore nuovo, motivo |
| APP-AU-02 | Il core concatena gli eventi nel proprio audit ledger firmato, così un ispettore vede una sola traccia anche se i dati sono in più sistemi |
| APP-AU-03 | Le app L3 espongono anche il proprio audit trail completo in sola lettura per le ispezioni |

### 4.7 SDK e sandbox

- SDK TypeScript e Python (`@trialops/sdk`) che incapsula autenticazione, chiamate, eventi, task e audit; esempio di app "hello-trial" funzionante.
- Sandbox pubblica con dati sintetici e un'app di test per la certificazione del contratto (test automatici che un'app deve passare per essere pubblicata nel catalogo).
- La prima app di terzi da integrare per la demo è il motore di simulazione IST (TA1), la seconda un'app di terzi di classe L1 (per esempio un cruscotto) per dimostrare il contratto con un fornitore esterno.

## 5. Modello dati di dominio

Il modello dati è la parte che non si improvvisa nella demo: è lo stesso dalla prima riga di codice. Tutte le entità cliniche sono tabelle tipizzate PostgreSQL con chiavi UUID, vincoli, versioning e audit trigger. Nessuna cancellazione fisica di dati GxP: solo stato `void` con motivo.

| Area | Entità | Campi chiave e note |
| --- | --- | --- |
| Organizzazioni | `organization`, `person`, `role_assignment` | Tipo organizzazione (lead operator, sponsor, sito, CRO, vendor, comitato); assegnazione di ruolo con perimetro (piattaforma, braccio, sito) e date di validità |
| Protocollo | `platform`, `master_protocol_version`, `arm`, `arm_appendix_version`, `arm_stage`, `stage_transition_rule` | Il Master Protocol e le appendici sono documenti strutturati (USDM) con versioni approvate; `arm_stage` = dose finding, espansione, efficacia, conferma; le regole di transizione sono prespecificate e collegate al SAP |
| Controlli | `control_group`, `control_sharing_rule` | Quali controlli sono condivisibili tra quali bracci, concorrenti o non concorrenti, con quali criteri I/E |
| Siti | `site`, `site_arm_activation`, `site_feasibility`, `site_kpi_snapshot` | Stato di attivazione per braccio, date di ogni passo, capacità dichiarata, performance |
| Soggetti | `subject`, `prescreening`, `consent`, `eligibility_assessment`, `randomization`, `subject_stage_status` | Solo dati pseudonimizzati nel core; l'identità resta al sito o all'app eConsent; `randomization` registra braccio, schema e versione dell'algoritmo usato |
| Visite e dati | `visit_schedule`, `visit`, `data_reference` | Il core registra eventi e stati delle visite; i dati CRF restano nell'EDC (modulo o app) e sono referenziati con provenienza |
| Safety | `adverse_event`, `safety_case`, `safety_signal_review` | Casi con stato, scadenze regolatorie, link ai bracci coinvolti, revisioni di segnale cross-braccio |
| Qualità | `deviation`, `risk`, `kri_definition`, `kri_value`, `capa`, `monitoring_visit` | RBQM secondo ICH E6(R3): rischi a livello piattaforma e braccio, soglie KRI, azioni |
| Documenti | `document`, `document_version`, `tmf_artifact`, `approval` | Classificazione TMF Reference Model (zona, sezione, artifact), livello (piattaforma, braccio, sito), stato, firma |
| Regolatorio | `submission`, `submission_item`, `irb_review`, `regulatory_milestone` | IND, emendamenti, safety report, IRB; date di invio e di risposta per le metriche |
| Contratti e vendor | `contract`, `contract_amendment`, `vendor`, `vendor_oversight_review` | Contratto quadro di piattaforma e allegato per braccio; tempi di negoziazione |
| Supply | `ip_product`, `ip_lot`, `ip_shipment`, `ip_inventory` | Per la demo solo inventario e spedizioni per sito e braccio |
| Decisioni | `adaptation_decision`, `committee_meeting`, `decision_record` | Decisione (es. stop per futilità, cambio di allocazione), organo che decide, input ricevuti, implementazione in TA3 con tempi |
| Lavoro | `task`, `task_event`, `time_entry` | Vedi contratto task; `time_entry` per le ore-uomo |
| Finanza | `budget`, `budget_line`, `cost_movement`, `allocation_key`, `site_payment`, `invoice`, `forecast` | Vedi sezione 8; movimenti reali e previsioni in tabelle separate |
| Metriche | `metric_definition`, `metric_event`, `metric_value` | Ogni metrica SURPASS è calcolata da eventi con timestamp, mai inserita a mano |
| AI | `ai_request`, `ai_task`, `ai_model`, `prompt_version`, `tool_call`, `agent_decision_record` | Dal libro mastro dell'AI Gateway, più il record firmato della decisione |
| Sistema | `audit_event`, `signature`, `app_installation`, `app_scope_grant`, `event_outbox` | Infrastruttura comune |

| ID | Requisito |
| --- | --- |
| DM-01 | Ogni entità clinica ha `platform_id` e, quando pertinente, `arm_id` e `site_id`; le policy RLS si basano su questi tre campi |
| DM-02 | Le entità controllate (protocollo, appendici, documenti, regole) hanno versioni immutabili; una modifica crea una nuova versione |
| DM-03 | Ogni scrittura genera un `audit_event` con utente, timestamp UTC, valore precedente, valore nuovo e motivo (obbligatorio per modifiche dopo la prima registrazione) |
| DM-04 | Le migrazioni di schema sono versionate (es. sqitch o migrazioni del framework) e testate con pgTAP, come in ist-clinical-platform |
| DM-05 | Il seed della demo genera dati sintetici coerenti con questo modello (sezione 12); nessun dato reale entra mai nell'ambiente demo |

## 6. Identità, ruoli e permessi

L'accesso combina il ruolo (cosa puoi fare) con il perimetro (su quale piattaforma, braccio, sito) e lo stato di blinding. È l'evoluzione di `user_has_module()` di Grant OS: da "quali moduli vedi" a "quali oggetti di quale braccio vedi".

| Ruolo | Organizzazione tipica | Perimetro | Può vedere dati non in cieco |
| --- | --- | --- | --- |
| Platform admin | Lead operator | Piattaforma | No |
| Platform operations manager | Lead operator | Piattaforma | No |
| Arm sponsor lead | Sponsor | Solo il proprio braccio | No |
| Clinical trial manager / CRA | Lead operator o CRO | Piattaforma o siti assegnati | No |
| Site PI / study coordinator | Sito | Proprio sito, bracci attivati | No |
| Regulatory lead | Lead operator o sponsor | Piattaforma o braccio | No |
| Safety physician | Lead operator | Piattaforma (casi di tutti i bracci) | Solo per casi singoli, se previsto dal piano di safety |
| Data manager | Lead operator | Piattaforma | No |
| SAC member / unblinded statistician | Comitato indipendente | Enclave SAC | Sì |
| DSMB member | Comitato | Report SAC | Sì, solo report |
| Finance controller | Lead operator / sponsor | Piattaforma o braccio | Non pertinente |
| QA / auditor / ispettore | Interno o esterno | Sola lettura, perimetro assegnato | No |
| Agente AI | Sistema | Perimetro del task che esegue | No, mai |

| ID | Requisito |
| --- | --- |
| IAM-01 | SSO OIDC con MFA obbligatoria per ruoli con impatto GxP; utenti interni via Entra ID, utenti esterni via federazione con il loro IdP o account gestiti dal broker |
| IAM-02 | Le policy RLS in PostgreSQL leggono dal JWT `org_id`, `platform_ids`, `arm_scopes`, `site_scopes`, `blinding` (stesso schema `request.jwt.claims` del piano di migrazione Azure) |
| IAM-03 | Uno sponsor non vede mai dati, documenti, costi o metriche disaggregate di un altro braccio; i dati aggregati di piattaforma sono visibili solo se approvati dal comitato di governance |
| IAM-04 | I dati non in cieco vivono in uno schema separato (`sac_enclave`) accessibile solo a ruoli `unblinded`; ogni accesso è registrato e mostrato nel report di blinding |
| IAM-05 | Separazione dei compiti: chi crea un documento o una modifica GxP non può approvarla da solo |
| IAM-06 | Revisione periodica degli accessi (ogni 90 giorni) generata come task per il platform admin |
| IAM-07 | Gli agenti AI hanno un'identità di servizio propria, con perimetro limitato al task e senza mai il claim `unblinded` |

## 7. Moduli funzionali TA3

I moduli coprono le attività a–w del bando. Per ogni requisito la colonna **AI** indica il ruolo dell'intelligenza artificiale (P = propone, l'umano firma; A = automatico su azioni reversibili e non GxP; – = nessuno). La colonna **Demo** dice se va nella demo (Sì / Parziale / Dopo). Il criterio di accettazione è la metrica SURPASS dove esiste.

### M01 – Master Protocol e onboarding dei bracci (TA3 a, b, c, u)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M01-01 | Editor strutturato del Master Protocol e delle appendici di braccio (sezioni ICH M11, oggetti USDM: obiettivi, endpoint, popolazione, schema visite, regole di transizione) | P: bozza di sezioni da template e da documenti dello sponsor | Sì |
| M01-02 | Wizard "Nuovo braccio": raccoglie dati dello sponsor, genera appendice, checklist di onboarding, task per regolatorio, contratti, siti, supply, data management | P: genera appendice e checklist; verifica coerenza con il Master Protocol | Sì |
| M01-03 | Feasibility del nuovo braccio: compatibilità della popolazione con i controlli condivisi, impatto dei criteri I/E specifici, capacità dei siti | P: analisi di compatibilità con evidenze citate | Parziale |
| M01-04 | Ciclo di vita del braccio (bozza → approvato → attivo → sospeso → chiuso / laureato) e degli stadi, con eventi | – | Sì |
| M01-05 | Implementazione delle adattazioni decise in TA2: dal `decision_record` firmato nascono automaticamente i task operativi (nuova allocazione all'IRT, comunicazioni ai siti, aggiornamento documenti), con tempo misurato dalla decisione all'implementazione | P: piano di implementazione | Parziale |
| M01-06 | Diff tra versioni di protocollo e appendici, con impatto su eCRF, TMF, IRT e formazione | P: riassunto dell'impatto | Dopo |

Accettazione: un braccio nuovo passa da "bozza" a "pronto per sottomissione" con tutti i task generati in meno di 1 giorno lavorativo nella demo.

### M02 – Rete dei siti (TA3 l)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M02-01 | Anagrafica siti, investigatori, capacità, trial concorrenti, certificazioni | – | Sì |
| M02-02 | Questionario di feasibility inviato al sito, con risposte strutturate | P: punteggio di idoneità e sintesi | Sì |
| M02-03 | Workflow di attivazione per braccio: qualifica, contratto, IRB, formazione, green light; ogni passo con data | – | Sì |
| M02-04 | Cruscotto performance per sito (arruolamento, screen failure, tempi di data entry, query aperte, deviazioni) con soglie e piani di azione | P: segnala siti sotto soglia e propone azioni | Sì |
| M02-05 | Close-out per braccio e per sito con checklist | – | Dopo |

### M03 – Contratti e vendor (TA3 d, r)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M03-01 | Contratto quadro di piattaforma con allegato per braccio; libreria di clausole approvate | P: genera l'allegato dal template e dall'appendice | Sì |
| M03-02 | Workflow di negoziazione con versioni, commenti, redline e firma | P: confronta con le clausole standard, segnala scostamenti | Parziale |
| M03-03 | Registro vendor con qualifica, KPI, revisioni di oversight periodiche | P: sintesi delle performance | Parziale |

Accettazione: tempo di esecuzione del contratto per nuovo braccio misurato dall'evento `arm.created` a `contract.executed` (target SURPASS < 1 settimana).

### M04 – Regolatorio e IRB (TA3 e, f, k)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M04-01 | Tracker delle sottomissioni (IND di piattaforma, emendamenti per braccio, safety report, annual report) con scadenze | – | Sì |
| M04-02 | Pacchetto IRB generato dal protocollo strutturato (appendice, consenso, materiale per pazienti, CV) per IRB centrale | P: assembla il pacchetto e verifica completezza | Sì |
| M04-03 | Regulatory path assistant: per ogni prossimo milestone elenca azioni richieste, dipendenze ed evidenze mancanti | P: con riferimenti alle guidance | Parziale |
| M04-04 | Registro delle interazioni con FDA (meeting, minute, impegni) | P: estrae impegni dalle minute | Dopo |

Accettazione: tempi misurati IND → primo soggetto dosato, "may proceed" → FSD per braccio, approvazione IRB per braccio.

### M05 – Pazienti: pre-screening, reclutamento, consenso, arruolamento (TA3 g, m, j)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M05-01 | Pre-screening da dati strutturati (FHIR dal sito) o da inserimento manuale, contro i criteri I/E di piattaforma e di braccio | P: valutazione criterio per criterio con evidenza; decide il PI | Sì |
| M05-02 | Funnel di reclutamento per sito e braccio (identificati → pre-screenati → consenso → screening → randomizzati) | – | Sì |
| M05-03 | Arruolamento reale vs previsto: il core pubblica ogni settimana `enrollment.snapshot.published`; l'app TA1 restituisce la previsione aggiornata; il cruscotto mostra scarto e trend | – | Sì |
| M05-04 | Integrazione con app eConsent (L3) via contratto; il core registra solo stato e versione del consenso | – | Parziale |
| M05-05 | Retention: alert su visite mancate e rischio di abbandono | P: segnalazione con motivazione | Dopo |

Accettazione: scarto medio tra arruolamento reale e previsto calcolato automaticamente (target SURPASS ± 25%).

### M06 – Dati clinici e dataset (TA3 h, i)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M06-01 | Orchestrazione EDC: dal protocollo strutturato si generano le specifiche eCRF da passare all'EDC (modulo o app) | P: bozza delle specifiche eCRF | Parziale |
| M06-02 | Ingestione dati da EDC, laboratori, EHR (FHIR) con data reference e provenienza | – | Parziale |
| M06-03 | Edit check e query: regole deterministiche + rilevazione di anomalie | P: propone query; il data manager le apre | Sì |
| M06-04 | Mapping continuo verso SDTM e dataset di analisi, con lineage e versione di ogni trasformazione | P: propone mapping; programmatore valida | Dopo |
| M06-05 | Data freeze per interim analysis: snapshot immutabile con hash, consegnato all'enclave SAC | – | Parziale |

Accettazione: tempo da visita a dato disponibile (target ≤ 2 giorni) e da freeze a dataset pronto (target ≤ 1 settimana), misurati da eventi.

### M06b – EDC nativo (decisione del 6 ottobre 2026)

L'EDC è sviluppato da IST come modulo del core, non come app esterna. È un sistema di record GxP: valgono tutti i controlli Part 11 del core (audit, firme, versioni, RLS) e la validazione è a carico nostro.

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| EDC-01 | Libreria di form (CRF) versionata, con campi tipizzati, unità, range, codelist CDISC CDASH; ogni form è legato a visite del protocollo strutturato | P: bozza dei CRF dallo schema visite USDM | Sì |
| EDC-02 | Pubblicazione di una versione di eCRF per braccio e stadio; i dati raccolti restano legati alla versione con cui sono stati inseriti; migrazione controllata dei dati tra versioni | – | Parziale |
| EDC-03 | Data entry da sito con salvataggio automatico, campi condizionali, calcoli derivati, gestione dati mancanti (ND/NA/UNK) | – | Sì |
| EDC-04 | Edit check deterministici dichiarativi (range, coerenza tra campi e visite, date) eseguiti all'inserimento e in batch | P: proposta di nuovi edit check dai dati osservati | Sì |
| EDC-05 | Query: apertura (manuale, da edit check o proposta da agente), risposta del sito, chiusura; stato e tempi per metrica | P: query proposte da anomalie | Sì |
| EDC-06 | Source data verification e review per campo/form (SDV, data manager review, medical review) con stati e firme | – | Parziale |
| EDC-07 | Firma del PI per form e per casebook (Part 11) | – | Parziale |
| EDC-08 | Lock per form, visita, soggetto e data freeze per interim (snapshot immutabile con hash, verso l'enclave SAC) | – | Parziale |
| EDC-09 | Export CDISC ODM-XML e Dataset-JSON; base per il mapping SDTM (M06-04) | – | Dopo |
| EDC-10 | Import da laboratori e EHR (FHIR) nelle visite, con provenienza | – | Dopo |
| EDC-11 | Il dato del braccio non compare mai in eCRF o liste viste da utenti in cieco | – | Sì |
| EDC-12 | Evento `visit.completed` emesso alla chiusura della visita; tempo visita → dato disponibile per la metrica TA3 (≤ 2 giorni) | – | Sì |

### M07 – Safety (TA3 q)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M07-01 | Registrazione AE/SAE dal sito o dall'EDC, con scadenze regolatorie (7/15 giorni) calcolate | – | Sì |
| M07-02 | Codifica MedDRA assistita | P: proposta di codice; conferma del safety physician | Parziale |
| M07-03 | Bozza di narrativo del caso | P | Sì |
| M07-04 | Revisione di segnale cross-braccio: eventi simili in più bracci, con regole su chi valuta e chi decide | P: evidenzia cluster | Parziale |
| M07-05 | Riconciliazione safety database ↔ EDC | A: confronto automatico, discrepanze come task | Dopo |

La valutazione di causalità e l'invio regolatorio restano sempre decisioni umane.

### M08 – Qualità: RBQM, deviazioni, monitoraggio, formazione (TA3 n, o, t, w)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M08-01 | Registro dei rischi a livello piattaforma e braccio, KRI con soglie, cruscotto di monitoraggio centralizzato | P: segnala superamenti e propone azioni | Sì |
| M08-02 | Rilevazione delle deviazioni da dati e documenti (visite fuori finestra, consenso non aggiornato, farmaco errato) | P: deviazione proposta, classificata dal CTM | Sì |
| M08-03 | Trend delle deviazioni per sito, braccio, tipo; CAPA collegate | – | Parziale |
| M08-04 | Formazione: matrice ruolo → corsi, registrazione di completamento, blocco di attività per chi non è formato | P: genera quiz da SOP e appendici | Parziale |
| M08-05 | Inspection readiness: cruscotto di completezza (TMF, formazione, deviazioni aperte, audit trail) per piattaforma e braccio | P: elenco di lacune | Sì |

### M09 – eTMF e documenti controllati (TA3 s, b)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M09-01 | Archivio documenti con struttura TMF Reference Model a tre livelli (piattaforma, braccio, sito) | – | Sì |
| M09-02 | Classificazione e archiviazione automatica dei documenti caricati (zona, sezione, artifact, metadati) | P: proposta di classificazione con confidenza; QC umano | Sì |
| M09-03 | Workflow di revisione e approvazione con firma Part 11; versioni approvate immutabili | – | Sì |
| M09-04 | Completezza attesa vs presente per ogni livello e milestone | A: calcolo automatico | Sì |
| M09-05 | Esportazione del TMF in formato di scambio standard | – | Dopo |

### M10 – Supply clinica (TA3 p)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M10-01 | Inventario per sito e braccio, lotti, scadenze, spedizioni | – | Parziale |
| M10-02 | Previsione dei fabbisogni da arruolamento previsto e allocazione corrente | P: proposta di rifornimento | Dopo |
| M10-03 | Integrazione con IRT (app L3) per randomizzazione e dispensazione | – | Dopo |

### M11 – Risorse, metriche e cruscotto SURPASS (TA3 j, v)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M11-01 | Catalogo delle metriche SURPASS con definizione, formula, eventi sorgente, target intermedio e finale | – | Sì |
| M11-02 | Cruscotto metriche vs target per piattaforma e braccio, con drill-down fino all'evento | – | Sì |
| M11-03 | Ore-uomo per attività e milestone (FSD, primo braccio completo, terzo braccio completo) da `time_entry` e durata dei task, confrontabili con lo storico | – | Parziale |
| M11-04 | Previsione delle risorse necessarie per i prossimi bracci | P | Dopo |
| M11-05 | Report periodico per ARPA-H generato dai dati | P: bozza del testo; numeri sempre da query | Parziale |

### M12 – Governance di piattaforma (governance a–k del bando)

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| M12-01 | Organi (Steering Committee, SAC, DSMB, comitato sponsor) con membri, mandato, riunioni e verbali (riuso `gov_*` di Grant OS) | P: bozza di verbale da registrazione o note | Parziale |
| M12-02 | Matrice dei diritti decisionali: chi propone, chi decide, chi viene informato per ogni tipo di decisione | – | Sì |
| M12-03 | Escalation: problema → livello → tempo massimo → livello successivo, con task e notifiche | – | Sì |
| M12-04 | Registro dei conflitti tra sponsor e delle politiche di accesso ai dati e pubblicazione | – | Dopo |

## 8. Modulo economico-finanziario

Il modulo estende Grant OS Finance con le dimensioni del trial di piattaforma (piattaforma, braccio, sito, sponsor) e applica le regole già collaudate nel Registro Costi FIN-021. Serve a tre utenti: il lead operator (costi condivisi e ripartizione), lo sponsor biotech (costo e runway del proprio braccio), il program manager ARPA-H (milestone e cost share).

**Regole ereditate da FIN-021 (vincolanti)**

- Movimenti reali e previsioni in tabelle diverse: `cost_movement` contiene solo ciò che è accaduto fino alla data di taglio; `forecast` contiene budget e previsioni.
- Chiave fornitore deterministica (partita IVA o nome normalizzato), mai progressiva.
- L'ultimo mese importato è `provvisorio` e viene ricalcolato all'import successivo.
- Ogni import esegue le verifiche di qualità (duplicati per fonte + id, importi non numerici, continuità delle chiavi, totali dei mesi definitivi invariati) e produce un report.
- Distinzione esplicita tra importi imponibili e lordi (`base`).

| ID | Requisito | AI | Demo |
| --- | --- | --- | --- |
| FIN-01 | Struttura di budget con le categorie del ROM SURPASS: setup piattaforma, manutenzione, bracci, TA1, TA2, TA3, regolatorio, biostatistica; per Stage I e Stage II | – | Sì |
| FIN-02 | Centri di costo a tre livelli (piattaforma, braccio, sito) e per sponsor | – | Sì |
| FIN-03 | Chiavi di ripartizione dei costi condivisi configurabili e versionate: pazienti randomizzati, contributo ai controlli condivisi, siti attivi, mesi in piattaforma, quota fissa; simulazione "cosa succede se entra un braccio in più" | P: spiega la ripartizione allo sponsor | Sì |
| FIN-04 | Pagamenti ai siti generati dagli eventi `visit.completed` e dalle fee di attivazione, secondo il budget del contratto di sito; holdback e pass-through | – | Parziale |
| FIN-05 | Import fatture CRO, vendor e siti con le regole FIN-021; riconciliazione con ordini e contratti | P: estrazione dati da PDF di fattura; conferma umana | Parziale |
| FIN-06 | Accrual mensile per braccio (costo maturato su pazienti e milestone vs fatturato) | P: bozza del commento alle variazioni | Parziale |
| FIN-07 | Runway dello sponsor: cassa disponibile, burn mensile, costo previsto del braccio collegato all'arruolamento previsto (da TA1); un ritardo di arruolamento si traduce in mesi di runway | P: scenario commentato | Sì |
| FIN-08 | rNPV per braccio con probabilità di successo aggiornata dalle decisioni go/no-go | – | Dopo |
| FIN-09 | Benchmark costo per braccio vs tre quotazioni CRO caricate (metrica SURPASS) | – | Sì |
| FIN-10 | Gestione OT ARPA-H: milestone di pagamento, deliverable, cost share, fatturazione elettronica (riuso modulo Grants) | P: verifica completezza dei deliverable | Parziale |
| FIN-11 | Costo AI per braccio e per attività dal libro mastro dell'AI Gateway (costo per task riuscito) | – | Sì |
| FIN-12 | Esportazioni verso ERP e Cost Workbook ARPA-H; nessuna contabilità generale nel modulo | – | Dopo |

| ID | Requisito di riservatezza |
| --- | --- |
| FIN-SEC-01 | Ogni sponsor vede solo costi e ripartizioni del proprio braccio e la propria quota dei costi condivisi, mai i prezzi o i contratti degli altri |
| FIN-SEC-02 | Modifiche a budget, chiavi di ripartizione e prezzi sono versionate, motivate e firmate |

## 9. AI layer GxP

L'AI layer è l'AI Gateway della spec del 13 settembre, con quattro estensioni per il contesto GCP: classi di dati cliniche, allowlist di modelli qualificati, versioni bloccate e firma umana sugli output GxP. Le azioni degli agenti passano dal controllo deterministico in stile Deontos.

**Nota sui modelli "certificati GCP".** Nessun LLM (Claude, GPT o altri) è certificato per l'uso GCP in quanto tale. La conformità nasce da due cose: il **contratto con il fornitore** (DPA, BAA dove servono dati sanitari USA, conservazione dati nulla o limitata, residenza dei dati, certificazioni di sicurezza) e la **validazione dell'uso previsto** fatta da noi. La piattaforma quindi qualifica fornitori e modelli, non li considera conformi a priori.

**Provider previsti**

| Provider | Canale | Uso consentito | Nota |
| --- | --- | --- | --- |
| Anthropic Claude | API diretta enterprise, oppure AWS Bedrock / Google Vertex | Tutte le classi tranne `STRICT_LOCAL`, se il contratto copre i dati | Verificare BAA, zero data retention e regione |
| OpenAI | Azure OpenAI nel tenant IST | Tutte le classi tranne `STRICT_LOCAL`, se il contratto copre i dati | Coerente con l'infrastruttura Azure già scelta |
| Modelli open-weight locali | vLLM/Ollama su infrastruttura IST | Tutte le classi, incluso `STRICT_LOCAL` | Già in uso in Local Dev (Qwen, Gemma) |
| OpenRouter e simili | API | Solo `PUBLIC` e sviluppo, mai dati di trial | Utile per benchmark |

**Classi di dati (estensione di `privacy_level`)**

| Classe | Esempi | Provider ammessi |
| --- | --- | --- |
| `PUBLIC` | Guidance FDA, letteratura | Tutti |
| `INTERNAL` | Template, SOP, bozze | Provider qualificati |
| `CONFIDENTIAL_SPONSOR` | Dati di braccio, contratti, costi | Provider qualificati con DPA; mai mescolare dati di sponsor diversi nello stesso contesto |
| `CLINICAL_PSEUDONYMIZED` | Dati soggetto pseudonimizzati, AE, deviazioni | Provider qualificati con DPA/BAA e residenza conforme, oppure locale |
| `STRICT_LOCAL` | Dati identificativi, dati non in cieco dell'enclave SAC | Solo modelli locali nel perimetro |

**Requisiti**

| ID | Requisito |
| --- | --- |
| AI-01 | Nessun modulo o app chiama un provider direttamente: tutto passa da `POST /api/ai/tasks` con `task_type`, `data_class`, `quality`, `input` (come da spec, § 63) |
| AI-02 | Ogni `task_type` GxP è registrato con: uso previsto, livello di rischio, modello e versione esatti approvati, prompt versionato, validatore, soglie di performance, dataset di test |
| AI-03 | Per i task GxP il routing è fisso sul modello validato: niente escalation automatica tra tier; un cambio di modello è una change request con riesecuzione dei test di regressione |
| AI-04 | Temperatura e parametri fissi, output strutturato con JSON Schema, citazione obbligatoria delle fonti (documento, pagina, campo) per estrazioni e classificazioni |
| AI-05 | Ogni output con impatto GxP diventa una proposta (`waiting_review`): diff visibile, fonti cliccabili, accetta/modifica/rifiuta con firma; il tasso di accettazione e di modifica è misurato per task type |
| AI-06 | Libro mastro: ogni chiamata registra richiesta, modello, versione, prompt version, hash input/output, costo, latenza, esito, revisore, decisione finale |
| AI-07 | Gli agenti operano solo con strumenti del tool registry; ogni strumento ha `required_role`, `risk_level`, `mode` = AUTO / CONFIRM / BLOCK |
| AI-08 | Ogni azione di un agente passa da un policy engine interno che decide ALLOW / REVIEW / BLOCK e produce un Agent Decision Record firmato |
| AI-09 | Limiti per job: `max_steps`, `max_tokens`, `max_cost`, `max_execution_time`; superati, il job si ferma e crea un task per una persona |
| AI-10 | Monitoraggio continuo per task type: accuratezza su campioni rivisti, deriva, tasso di rifiuto; sotto soglia il task type torna automaticamente in modalità "solo suggerimento" |
| AI-11 | L'AI non vede mai dati non in cieco fuori dall'enclave SAC e non esegue azioni riservate ad organi del trial (adattamenti, unblinding, causalità SAE, invii regolatori) |
| AI-12 | Voce (Voice Gateway) ammessa per input (verbali, note di visita CRA); la trascrizione è un documento sorgente solo dopo revisione |

**Catalogo agenti per la demo**

| Agente | Cosa fa | Modalità | Rischio |
| --- | --- | --- | --- |
| Protocol author | Bozza dell'appendice di braccio dal template e dai documenti dello sponsor | CONFIRM | Medio |
| Onboarding planner | Genera task e checklist per un nuovo braccio | AUTO (task non GxP) | Basso |
| IRB packager | Assembla e verifica il pacchetto IRB | CONFIRM | Medio |
| Contract reviewer | Confronta l'allegato di braccio con le clausole standard | CONFIRM | Medio |
| Pre-screening assistant | Valuta l'idoneità criterio per criterio con evidenze | CONFIRM (decide il PI) | Alto |
| TMF filer | Classifica e archivia documenti | CONFIRM con QC a campione | Medio |
| Deviation detector | Propone deviazioni da dati e documenti | CONFIRM | Alto |
| Safety narrative writer | Bozza del narrativo di caso | CONFIRM | Alto |
| Metrics reporter | Testo del report periodico, numeri da query | CONFIRM | Basso |

## 10. Compliance e validazione

La demo non deve essere validata, ma deve essere costruita in modo che la validazione sia un'attività di documentazione e test, non una riscrittura. Si riusa il livello V&V di ist-clinical-platform (pgTAP, Vitest, CI, matrice di tracciabilità) con approccio CSA (Computer Software Assurance): sforzo di test proporzionato al rischio della funzione.

| ID | Riferimento | Requisito tecnico |
| --- | --- | --- |
| CMP-01 | 21 CFR Part 11 / EU Annex 11 – audit trail | Audit trail generato dal sistema, append-only, con utente, timestamp UTC sincronizzato, valori prima/dopo, motivo; catena di hash e firma Ed25519 per blocchi; non disattivabile da nessun ruolo |
| CMP-02 | Part 11 – firme elettroniche | Firma con riautenticazione, significato della firma (autore, revisore, approvatore), legame indissolubile con la versione firmata, manifestazione della firma su stampa ed export |
| CMP-03 | Part 11 – controllo accessi | Account univoci, MFA, timeout di sessione, blocco dopo tentativi falliti, revisione periodica accessi |
| CMP-04 | ALCOA+ | Ogni dato attribuibile, contemporaneo (timestamp di sistema), originale (provenienza), accurato (validazioni), completo, coerente, duraturo, disponibile |
| CMP-05 | ICH E6(R3) | RBQM (M08), governance dei dati, ricostruibilità di ogni decisione e adattamento, supervisione dei fornitori di servizi (app comprese) |
| CMP-06 | Guidance FDA sull'AI per decisioni regolatorie (bozza 2025) | Per ogni task type AI: contesto d'uso, rischio, piano di credibilità, risultati, monitoraggio (AI-02, AI-10) |
| CMP-07 | EU GMP Annex 22 (bozza) come riferimento metodologico | Dati di test indipendenti, metriche prespecificate, spiegabilità tramite fonti citate, controllo dei cambiamenti dei modelli |
| CMP-08 | GDPR / HIPAA | Pseudonimizzazione nel core, minimizzazione, registro dei trattamenti, DPA con fornitori, residenza dei dati per regione |
| CMP-09 | EU AI Act | Valutazione d'uso per ogni agente; trasparenza verso l'utente quando un contenuto è generato dall'AI |

**Pacchetto di validazione per release (generato dalla pipeline)**

1. Specifica dei requisiti con ID (questo documento è la versione 0).
2. Risk assessment per funzione (impatto su paziente, dati, decisione).
3. Matrice di tracciabilità requisito → test → evidenza, generata automaticamente dai tag dei test.
4. Evidenze dei test automatici (log CI firmati) e dei test manuali per le funzioni ad alto rischio.
5. Release note con modifiche, impatto e approvazione QA.

| ID | Requisito di processo |
| --- | --- |
| VAL-01 | Ogni test riporta nel nome o nei metadati gli ID dei requisiti che copre; la CI fallisce se un requisito "Sì" in demo non ha test |
| VAL-02 | Nessuna modifica diretta in test o prod: solo promozione da pipeline con approvazione |
| VAL-03 | Le migrazioni di database sono testate con pgTAP su copia anonimizzata o sintetica prima della promozione |
| VAL-04 | Le app di classe L2–L3 non vengono attivate in prod senza pacchetto di validazione del fornitore e test di integrazione del contratto superati |

## 11. Requisiti non funzionali e stack tecnologico

| ID | Area | Requisito |
| --- | --- | --- |
| NFR-01 | Prestazioni | Pagine principali < 2 s al 95° percentile con 50 utenti concorrenti; API di lettura < 300 ms p95 |
| NFR-02 | Scalabilità | Dimensionamento di riferimento: 1 piattaforma, 10 bracci, 30 siti, 2.000 soggetti, 500 utenti, 1 milione di eventi di audit l'anno |
| NFR-03 | Disponibilità | 99,5% in produzione; demo senza vincolo |
| NFR-04 | Backup e DR | Backup giornaliero con retention 30 giorni / 12 mesi / 5 anni (come piano Azure); RPO 24 h, RTO 8 h; test di restore trimestrale |
| NFR-05 | Sicurezza | TLS 1.2+, cifratura a riposo, segreti solo lato server in Key Vault, scansione dipendenze e SAST in CI, penetration test prima della produzione |
| NFR-06 | Multi-regione | Stesso codice deployabile in EU e US con dati separati per regione |
| NFR-07 | Accessibilità e lingua | WCAG 2.1 AA; UI in inglese, predisposta per altre lingue |
| NFR-08 | Osservabilità | Log strutturati, tracing distribuito tra gateway, API, app e AI runtime; cruscotto operativo |
| NFR-09 | Open source | Repository pubblico per core, SDK e schemi; licenza da decidere (sezione 14); nessuna dipendenza con licenza incompatibile |

**Stack di riferimento**

| Livello | Scelta | Motivo |
| --- | --- | --- |
| Frontend | React 18, TypeScript, Vite, libreria componenti accessibile | Evoluzione della shell Grant OS |
| Backend | Node.js 22 + TypeScript, NestJS o Express strutturato | Continuità con l'api-server Express |
| Database | PostgreSQL 16 + PostgREST 12 (letture) | Già nel piano di migrazione |
| Eventi | Outbox Postgres + NATS JetStream o Azure Service Bus | Semplice per la demo, scalabile |
| File | Azure Blob con versioning e immutabilità | Già nel piano di migrazione |
| Identità | Entra ID + Entra External ID o Keycloak | Utenti interni ed esterni |
| AI | `ai-runtime` (AI Gateway) + Deontos come policy decision point | Riuso dei progetti esistenti |
| Standard clinici | HAPI FHIR, librerie CDISC (ODM, Dataset-JSON, USDM) | Interoperabilità |
| Infrastruttura | Azure Container Apps, Terraform, GitHub Actions | Coerente con IST |
| Test | Vitest, Playwright, pgTAP, test di contratto per le app | Riuso di ist-clinical-platform |

## 12. Ambiente demo

La demo dura 20 minuti e mostra un'idea sola: con TrialOps un nuovo braccio entra in una piattaforma esistente in giorni invece che mesi, con l'AI che prepara e le persone che firmano, e ogni passo misurato contro le metriche SURPASS.

**Dati sintetici (seed `demo-plat-001`)**

- Piattaforma `PLAT-001`, area terapeutica fittizia "Malattia X" (nessun riferimento clinico reale).
- Lead operator "Northfield Clinical Institute" (fittizio), 3 sponsor fittizi (di cui 1 startup), IST come fornitore tecnologico.
- 3 bracci attivi + controllo condiviso; il 4° braccio entra durante la demo.
- 6 siti in USA con performance diverse (uno sotto soglia), 240 soggetti in vari stati, 18 mesi di storico eventi.
- Documenti TMF di esempio, 30 deviazioni, 12 AE di cui 2 SAE, budget e costi coerenti, 3 quotazioni CRO di riferimento.
- Il generatore di dati è riproducibile (stesso seed, stessi dati) e versionato nel repository.

**Script della demo**

1. **Cruscotto di piattaforma** (2 min): bracci, siti, arruolamento reale vs previsto, metriche SURPASS vs target.
2. **Nuovo braccio** (5 min): wizard; l'agente Protocol author prepara l'appendice; l'agente Onboarding planner genera task per regolatorio, contratti, siti, supply; l'utente rivede il diff e firma.
3. **Contratto e IRB** (3 min): allegato di braccio generato e confrontato con le clausole standard; pacchetto IRB assemblato; cronometro della metrica "contratto < 1 settimana" e "IRB < 1 settimana".
4. **App verticale** (3 min): installazione dal catalogo dell'app di simulazione IST (TA1); consenso agli scope; SSO senza nuovo login; l'app riceve l'evento `enrollment.snapshot.published`, ricalcola la previsione e crea un task "rivedere scenario" nell'inbox.
5. **Operations quotidiane** (3 min): pre-screening assistito con evidenze; deviazione proposta dall'agente e classificata dal CTM; documento caricato e archiviato nel TMF in automatico.
6. **Finanza** (2 min): costo del nuovo braccio, quota dei costi condivisi, runway dello sponsor startup che cambia con il ritardo di un sito; benchmark vs quotazioni CRO.
7. **Fiducia** (2 min): audit trail di un'azione dell'agente con Agent Decision Record firmato; pacchetto di validazione generato dalla pipeline.

| ID | Requisito della demo |
| --- | --- |
| DEMO-01 | Reset dell'ambiente demo allo stato iniziale con un comando, in meno di 5 minuti |
| DEMO-02 | Utenti demo preconfigurati per ogni ruolo (operator, sponsor, PI, CRA, QA), con cambio rapido di utente nella UI per mostrare i permessi |
| DEMO-03 | Funziona anche senza rete verso provider AI esterni: modalità con risposte AI registrate o modello locale |
| DEMO-04 | Etichetta visibile "Dati sintetici – ambiente dimostrativo" su ogni pagina |
| DEMO-05 | Versione in inglese per ARPA-H e partner US |

## 13. Piano di sviluppo

Tre rilasci demo, ognuno agganciato a una scadenza SURPASS: v0 per il Proposers' Day, v1 per la Solution Summary, v2 per il Pitch. Ogni rilascio è dimostrabile da solo.

&#91;embedded content: piano di sviluppo · 3 rilasci demo sulle scadenze SURPASS\]

Le date presuppongono che la migrazione di Grant OS su Azure sia chiusa entro il 23 ottobre; se slitta, slitta tutto.

| Rilascio | Contenuto | Requisiti principali |
| --- | --- | --- |
| Fondamenta (7–23 ott) | Monorepo, migrazione Grant OS completata, modello dati (sezione 5), IAM con perimetri, audit ledger, servizio firme, event outbox, task engine minimo, pipeline CI con matrice di tracciabilità, seed sintetico | DM-01…DM-05, IAM-01…IAM-05, CMP-01…CMP-03, VAL-01…VAL-02 |
| Demo v0 (26 ott–4 nov) | Cruscotto di piattaforma, bracci e siti, wizard nuovo braccio con agenti Protocol author e Onboarding planner, catalogo app con installazione e SSO di un'app TA1 di prova | M01-01, M01-02, M01-04, M02-01, M02-03, M11-01, M11-02, APP-MF-01, APP-ID-01…APP-ID-02, AI-01, AI-05, AI-06 |
| Demo v1 (5–27 nov) | Contratti e IRB, TMF con archiviazione assistita, deviazioni, pre-screening, finanza di base (budget, ripartizione, runway), contratto task completo, primo Agent Decision Record | M03-01, M04-01, M04-02, M05-01…M05-03, M08-01, M08-02, M09-01…M09-04, FIN-01…FIN-03, FIN-07, APP-TK-01…APP-TK-07, AI-07, AI-08 |
| Demo v2 (30 nov–15 gen) | App di simulazione IST reale collegata via SDK, EDC nativo (M06b) con eCRF generato dal protocollo, safety, inspection readiness, benchmark CRO, costi AI, report metriche, pacchetto di validazione generato, versione inglese | APP-DT-01…APP-DT-07, APP-AU-01…APP-AU-03, M07-01, M07-03, M08-05, FIN-09, FIN-11, M11-05, DEMO-01…DEMO-05 |

**Ordine di costruzione dentro ogni rilascio:** modello dati e migrazioni → API con test di contratto → eventi e audit → UI → agenti AI. Un agente non si costruisce prima che l'azione manuale equivalente funzioni e sia tracciata.

**Definition of done di ogni requisito**

- Codice in main con revisione, lint, build e test verdi (quality gate di Forge).
- Test automatici taggati con l'ID del requisito; per i requisiti a rischio alto anche uno scenario Playwright.
- Endpoint documentati in OpenAPI ed eventi nel catalogo.
- Ogni scrittura GxP produce audit; ogni azione AI produce una riga di libro mastro.
- Visibile e funzionante nell'ambiente demo con i dati sintetici.

## 14. Decisioni da prendere prima di avviare lo sviluppo

**Decise il 6 ottobre 2026**

| # | Decisione | Esito |
| --- | --- | --- |
| 1 | Repository | Nuovo monorepo `trialops`; la shell di Grant OS entra come pacchetto |
| 2 | Infrastruttura | Tutto su Supabase per ora; la migrazione Azure non è un prerequisito della demo |
| 3 | Dati clinici | Tabelle tipizzate; `jsonb` solo per configurazione ed estensioni |
| 4 | Deontos | Fuori dal perimetro per ora; il controllo delle azioni degli agenti è un policy engine interno minimo (ALLOW/REVIEW/BLOCK + record firmato), sostituibile in futuro |
| 5 | Provider AI | Anthropic via API diretta per la demo; contratto da verificare per conservazione dati prima di usare dati reali |
| 6 | Utenti | Si riusa il componente di gestione utenti già sviluppato per le altre applicazioni (Supabase Auth); i perimetri piattaforma/braccio/sito si aggiungono come claim nel token |
| 7 | Licenza | AGPL-3.0 per il core; SDK e schemi da valutare con licenza permissiva per non ostacolare le app di terzi |
| 8 | EDC | Sviluppato da IST come modulo nativo (M06b) |
| 9 | Nome | "TrialOps" come nome di lavoro; verifica del marchio in seguito |
| 10 | Avvio | Sviluppo avviato; rilascio "Fondamenta" completato il 6 ottobre 2026 (34 test verdi) |

**Ancora da verificare**

- [ ] Verificare come il componente utenti esistente può aggiungere al token i claim `platform_ids`, `arm_scopes`, `site_scopes`, `blinding` (su Supabase: custom access token hook)
- [ ] Confermare la licenza di SDK e schemi (AGPL o permissiva)

**Fonti interne usate**

- [ISO ARPA-H-SOL-26-164 SURPASS](https://claude.ai/code/artifact/a67fc63a-903c-40a4-b51f-70d964160cca) (analisi del 6 ottobre 2026)
- [Piano di migrazione InSilicoTrials OS su Azure, v1.0](https://drive.google.com/file/d/1V1ApY9EylSCWS9fFZ19tZx3nNg22ofv0/view)
- [AI Gateway spec v1](https://drive.google.com/file/d/1r4lHyMJdBlEZO0YqKEsH1QabrLuFQg0e/view) e [analisi](https://drive.google.com/file/d/1kXkG64zvno34qhI-BqndjGyf_uSuxQ0b/view)
- [Registro Costi FIN-021](https://drive.google.com/file/d/1CegFxGhe-IKQUgXUcojXFUiuzWgqywkx/view)
- [Deontos – Executive summary](https://drive.google.com/file/d/1aQ-MOK1x3v7GmPNAG6IF6jGCWL-mnRPJ/view)
- [AI-Native Architecture – handoff](https://drive.google.com/file/d/1o9Y1r9_NvngksNyypE_Ley7xwtrShP8z/view) (ist-clinical-platform, V&V GAMP 5/CSA)
