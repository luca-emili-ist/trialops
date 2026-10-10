# Assessment esterno — fornitori e preparazione

Versione 0.1 · 2026-10-10 · decisione 6 di `GCP_BY_DESIGN.md` §5 · ricerca web del 2026-10-10. Prezzi e capacità AI
sono quasi sempre non pubblici o dichiarati dal fornitore: vanno confermati in offerta. Il contatto è a cura di Luca.

## Shortlist consigliata

| # | Fornitore | Perché | Servizio da chiedere |
| --- | --- | --- | --- |
| 1 | **PQE Group** (Firenze; USA, UE, PQE Japan) | Unico che copre insieme Italia/UE, USA e Giappone con assessment Part 11 / Annex 11 dichiarati | Supplier assessment di TrialOps contro Part 11, Annex 11, EMA 2023, ERES/CSV giapponesi, GAMP 5; inspection readiness |
| 2 | **Rephine** (UK/UE) | Audit di fornitori di sistemi AI e readiness Annex 22; modello a report condivisi riutilizzabili dagli sponsor | Shared supplier audit IT + modulo AI (Annex 22 bozza, GAMP AI) |
| 3 | **ProPharma** (USA, 30+ paesi) — in alternativa **Advarra** | Audit SaaS strutturati e credibilità presso gli sponsor USA; Advarra ha rilasciato un'attestazione Part 11/Annex 11 a una piattaforma eSource (CRIO) | Audit SDLC/SaaS Part 11 + Annex 11; per Advarra attestazione pubblicabile (non è una certificazione regolatoria) |

Per sicurezza e gestione dell'AI, a parte: **Schellman** (SOC 2 Type II, ISO 27001/27701, ISO 42001; SOC 2 indicativamente
20–100 k$, stima di terzi) oppure **BSI** (ISO 27001, ISO 42001 con pre-assessment).

Altri trovati: USDM Life Sciences (USA, cloud assurance SaaS, AI readiness), eCompliance Ltd. (Tokyo, ER/ES e CSV MHLW
in giapponese; materiale datato, verificare che sia operativa), Freyr, GxP-CC (validation readiness a prezzo fisso).

Fonti: pqegroup.com, rephine.com, propharmagroup.com, usdm.com, clinicalresearch.io (attestazione CRIO), ecompliance.co.jp,
schellman.com, bsigroup.com, freyrsolutions.com, gxp-cc.com.

## Cosa chiederanno prima dell'assessment, e dove siamo

| Documento | Stato in TrialOps |
| --- | --- |
| Manuale qualità e SOP (SDLC, change control, release, incidenti/CAPA, fornitori, formazione) | Mancante (QMS minimo, §4.4 punto 6) |
| URS/FS/DS, architettura, flussi dati, matrice di tracciabilità | Spec + `requirements.json` + `traceability.md`; mancano FS/DS formali |
| Strategia di validazione (GAMP 5/CSA), risk assessment, evidenze di test, report | Profilo di rischio per requisito e evidenze CI; mancano piano e report |
| Mappatura Part 11 / Annex 11 / ERES di audit trail, firme, accessi | `compliance-matrix.md` generata dalla CI |
| Data integrity, backup/restore, DR/BCP (RPO/RTO), conservazione | `BACKUP_RESTORE.md` (NFR-04) |
| Subfornitori (Supabase, Netlify, Anthropic, GitHub): SOC 2, ISO 27001, DPA, regione | Da raccogliere (qualifica fornitori) |
| Sicurezza: policy, penetration test, vulnerabilità | Mancante (NFR-05, v1) |
| Contratto/SLA e quality agreement fornitore–cliente | Da scrivere |
| Organigramma, CV, formazione | Da preparare (QA in stand-by) |
| AI: uso previsto, model card, dati di test, criteri, monitoraggio, firma umana, change control dei modelli | Registry e ledger presenti; piani di credibilità mancanti (CMP-06, AI-02/03) |
| Mappatura ICH E6(R3) ed eTMF | Parziale (crosswalk E6R3) |
| Gestione release del codice open source AGPL | Da definire (tag, release firmate) |

Raccomandazione sui tempi: contattare i fornitori ora per offerta e calendario, ma fissare l'assessment dopo i P0 e il QMS
minimo, così il report misura il prodotto che si vende e non la demo.
