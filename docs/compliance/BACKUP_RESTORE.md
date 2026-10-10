# Backup, restore, conservazione e archiviazione (NFR-04)

Versione 0.1 · 2026-10-10 · norme: EU Annex 11 §7 e §17, EMA 2023 (backup e restore, archiviazione), Reg. (UE) 536/2014
art. 58, 21 CFR 11.10(c), 312.62 e 812.140, JP ERES (conservazione), J-GCP. Requisito: NFR-04 (release `gxp-p0`).

## 1. Obiettivi

| Parametro | Valore | Note |
| --- | --- | --- |
| RPO (dati persi al massimo) | 24 h oggi; **5 min con PITR** | La spec chiede 24 h; con dati di trial reali si raccomanda PITR |
| RTO (tempo di ripristino) | 8 h | Spec NFR-04 |
| Conservazione dei record | Policy per piattaforma, `core.platform.retention_years`, **minimo 25 anni** | Migration 0016; ogni modifica è auditata con motivo |
| Test di restore | Trimestrale e dopo ogni cambio di infrastruttura | Evidenza in `docs/compliance/evidence/` |

## 2. Situazione attuale (verificata il 2026-10-10)

Progetto Supabase `dbhmlvqrwkurxgeeidko` (TrialOps, eu-central-1):

- **Backup fisici giornalieri** completati (WAL-G), conservati per il periodo previsto dal piano Supabase.
- **PITR disattivato.** È un add-on a pagamento di Supabase: va deciso da Luca.
- **Nessun archivio a lungo termine.** I backup Supabase non coprono i 25 anni dell'art. 58 CTR.

## 3. Procedura

### 3.1 Backup operativi (Supabase)
1. Backup fisici giornalieri automatici di Supabase. Controllo settimanale con
   `supabase backups list --project-ref <ref>`: l'ultimo deve essere `COMPLETED` e più recente di 26 h.
2. Con PITR attivo: ripristino a un istante preciso dalla dashboard Supabase o con la Management API, sempre
   **su un progetto nuovo**, mai sopra la produzione.

### 3.2 Test di restore (trimestrale)
1. Lanciare lo script, che esegue una copia logica, la ripristina in un database vuoto e verifica:
   - stesso numero di righe;
   - stesso hash dell'ultimo evento di audit;
   - `core.audit_verify()` pulito sull'originale e sulla copia.

   ```
   node scripts/restore-test.mjs --source <url sorgente> --target-server <url server di prova> [--schemas core,sac_enclave]
   ```

2. Lo script scrive `docs/compliance/evidence/restore-test-<timestamp>.json`, con l'hash del backup, i tempi
   (misura del RTO) e l'esito.
3. L'evidenza si committa e la revisione del test si firma in TrialOps. Finché non c'è un QA nominato, firma il
   platform admin. Un esito FAIL apre una deviazione.
4. Il primo test (2026-10-10) è stato fatto sul database locale sintetico per qualificare lo script: esito PASS.
   Il test sulla produzione si fa con l'ok di Luca (via pooler 6543, schemi `core` e `sac_enclave`).

### 3.3 Archiviazione per 25 anni
- Alla chiusura di un trial, e ogni mese durante il trial, si esporta una copia certificata:
  - dati, audit trail, firme e documenti, in formato aperto (CMP-14, v1);
  - il dump logico, con l'hash SHA-256.
- L'export va in un archivio **WORM**: storage a oggetti con blocco di immutabilità e retention pari alla policy della
  piattaforma, nella stessa regione dei dati (UE, USA o Giappone).
- La scelta dell'archivio è una decisione di Luca, perché ha un costo e un fornitore da qualificare.
- La leggibilità a lungo termine è garantita dal formato aperto (CSV/JSON + PDF) e non dipende dalla versione di
  PostgreSQL.
- Alla scadenza della retention la distruzione è un'azione firmata e registrata, mai automatica.

## 4. Decisioni aperte per Luca

1. Attivare il PITR di Supabase sul progetto TrialOps: costo mensile aggiuntivo; richiede un compute adeguato.
2. Archivio WORM per i 25 anni: fornitore e regione.
3. Test di restore sulla produzione (dati sintetici) per la prima evidenza reale.
