# AI test datasets (AI-03, CMP-06)

One folder per task type, one JSON file per case: `{ "data_class": "...", "input": { ... } }`, synthetic data only
(rule 7). `scripts/ai-regression.mjs` runs them on a candidate model; a model change in `model-lock.json` must attach
the passing evidence. The cases here are the smoke set (case 001); the full set of the credibility plan
(`docs/ai/<task_type>.md` §4, built by a person other than the prompt author) is added under CMP-06.
