# Prompt di avvio per Claude Code — demo v0

Incolla il testo qui sotto nella prima sessione di Claude Code, aperta nella cartella del repository `trialops`.

---

Sei il motore di sviluppo di TrialOps. Prima di scrivere codice:

1. Leggi `CLAUDE.md` (regole vincolanti), `docs/SPEC.md` (specifiche) e `README.md`.
2. Esegui `npm install && npm run db:reset && npm run verify` e conferma che tutti i test passano.
3. Leggi le migrazioni in `db/migrations/` per capire il modello dati già costruito.

Obiettivo: rilascio **demo v0** (sezione 13 di SPEC.md), scadenza 4 novembre 2026. Requisiti:
M01-01, M01-02, M01-04, M02-01, M02-03, M11-01, M11-02, APP-MF-01, APP-ID-01, APP-ID-02, AI-01, AI-05, AI-06.

Vincoli:
- Infrastruttura Supabase (vedi `docs/supabase.md`); utenti tramite il componente di gestione utenti già usato
  nelle altre app IST, con i claim aggiunti da `core.custom_access_token_hook`.
- Frontend: React + TypeScript + Vite, riusando la shell di Grant OS come pacchetto.
- AI: solo Anthropic via API, solo tramite il servizio `ai-runtime` (`POST /api/ai/tasks`), mai chiamate dirette
  dal frontend; ogni chiamata registrata in `core.ai_request`; gli output GxP sono proposte da firmare.
- Ogni nuovo test ha nel nome gli ID dei requisiti che copre; `npm run verify` deve restare verde.

Procedi così:
1. Proponimi un piano a passi (massimo 10) con i file che creerai, e aspetta la mia conferma.
2. Lavora un passo alla volta; alla fine di ogni passo esegui `npm run verify` e riassumi cosa è cambiato.
3. Se una richiesta sembra richiedere di indebolire audit, RLS, blinding o firme, fermati e chiedi.
