import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const load = p => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false }); addFormats(ajv);
const validate = ajv.compile(load('../../packages/schemas/app-manifest.schema.json'));
const good = load('../../packages/schemas/examples/ist.simulation-ta1.manifest.json');

test('[APP-MF-01] reference manifest of the IST TA1 app is valid', () => {
  assert.equal(validate(good), true, JSON.stringify(validate.errors));
});
test('[APP-MF-01] L2/L3 apps must declare a validation package', () => {
  const m = structuredClone(good); delete m.validation_package_url;
  assert.equal(validate(m), false);
});
test('[APP-MF-01] unknown fields and non-https endpoints are rejected', () => {
  assert.equal(validate({ ...good, backdoor: true }), false);
  assert.equal(validate({ ...good, base_url: 'http://sim.example' }), false);
});
test('[APP-DT-04] every event in the catalogue is a dotted lowercase CloudEvents type', () => {
  const cat = load('../../packages/schemas/events.catalog.json');
  assert.ok(cat.events.length >= 20);
  for (const e of cat.events) assert.match(e.type, /^[a-z_]+(\.[a-z_]+)+$/);
});
