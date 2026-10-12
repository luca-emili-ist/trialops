// UX-01 Suggest changes: component codes, which boxes are components, reading order; UX-02 "Copy as task".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { componentCode, classifyBox, orderComponents, snippet, changeRequestAsTask, SUGGEST_MAX, type BoxInfo } from '../src/ui/suggest.ts';

const box = (b: Partial<BoxInfo>): BoxInfo => ({ tag: 'div', explicit: false, width: 300, height: 120, rootWidth: 1000, display: 'block', controls: 0,
  inTable: false, inButton: false, radius: 0, outlined: false, fontSize: 14, fontWeight: 400, textLength: 40, childCount: 3, ownBackground: false, ruled: false, ...b });

test('[UX-01] component codes are PAGE-CODE.Cnn from the page code; a well-formed data-fc code wins', () => {
  assert.equal(componentCode('TRO-010', 4), 'TRO-010.C04');
  assert.equal(componentCode('TRO-010', 12), 'TRO-010.C12');
  assert.equal(componentCode('TRO-010', 4, 'TRO-010.C90'), 'TRO-010.C90');
  assert.equal(componentCode('TRO-010', 4, 'free text'), 'TRO-010.C04', 'a malformed explicit code is ignored');
});

test('[UX-01] tables, headings, charts, fields, toolbars, cards and bands are components; wrappers, cells and buttons are not', () => {
  assert.equal(classifyBox(box({ tag: 'table' })), 'table');
  assert.equal(classifyBox(box({ tag: 'h2' })), 'heading');
  assert.equal(classifyBox(box({ tag: 'svg', width: 200, height: 80 })), 'chart');
  assert.equal(classifyBox(box({ tag: 'svg', width: 16, height: 16 })), null, 'icons are not charts');
  assert.equal(classifyBox(box({ tag: 'input' })), 'field');
  assert.equal(classifyBox(box({ tag: 'select', inTable: true })), null, 'fields inside tables belong to the table');
  assert.equal(classifyBox(box({ display: 'flex', controls: 3, height: 40 })), 'toolbar');
  assert.equal(classifyBox(box({ radius: 16, outlined: true })), 'card');
  assert.equal(classifyBox(box({ shellKind: 'card' })), 'card', 'shell panels are recognised by class');
  assert.equal(classifyBox(box({ ownBackground: true, width: 900, height: 60 })), 'section');
  assert.equal(classifyBox(box({ childCount: 1, fontSize: 20, fontWeight: 700, textLength: 12 })), 'heading');
  assert.equal(classifyBox(box({})), null, 'a plain layout wrapper');
  assert.equal(classifyBox(box({ radius: 16, outlined: true, inTable: true })), null);
  assert.equal(classifyBox(box({ radius: 16, outlined: true, inButton: true })), null);
  assert.equal(classifyBox(box({ explicit: true, explicitKind: 'chart' })), 'chart');
  assert.equal(classifyBox(box({ explicit: true, explicitKind: 'nonsense' })), 'component');
});

test('[UX-01] numbering follows reading order, skips a box that only wraps another of the same size, stops at the maximum', () => {
  const r = (top: number, left: number, width = 100, height = 50) => ({ top, left, width, height });
  const tree: Record<string, string[]> = { outer: ['inner'], big: ['small'] };
  const contains = (a: string, b: string) => (tree[a] ?? []).includes(b);
  const out = orderComponents([
    { item: 'b', rect: r(200, 0) }, { item: 'outer', rect: r(10, 0, 302, 82) }, { item: 'inner', rect: r(12, 2, 298, 78) },
    { item: 'a2', rect: r(100, 400) }, { item: 'a1', rect: r(100, 0) }, { item: 'big', rect: r(300, 0, 600, 400) }, { item: 'small', rect: r(320, 20) },
  ], contains);
  assert.deepEqual(out.map(c => c.item), ['inner', 'a1', 'a2', 'b', 'big', 'small']);
  const many = Array.from({ length: 200 }, (_, i) => ({ item: String(i), rect: r(i, 0) }));
  assert.equal(orderComponents(many, () => false).length, SUGGEST_MAX);
});

test('[UX-01][UX-02] visible text is collapsed to 120 characters; Copy as task gives a Markdown brief for project trialops', () => {
  assert.equal(snippet('  a\n\n  b  '), 'a b');
  assert.equal(snippet('x'.repeat(300)).length, 120);
  const md = changeRequestAsTask({ id: '1b2c3d4e-0000-4000-8000-000000000000', page_code: 'TRO-020', component_code: 'TRO-020.C03', component_kind: 'table',
    component_text: 'Site network', dom_path: 'main > table', route: '#/sites', kind: 'change', request: 'Sort by activation date', status: 'triaged',
    triage_note: 'Next sprint', created_by: 'demo|cra', created_email: 'cra@x.test', created_at: '2026-10-12T09:00:00.000Z' });
  assert.match(md, /^# Change request 1b2c3d4e — TRO-020\.C03\n\nproject: trialops\n/);
  assert.match(md, /requested by cra@x\.test on 2026-10-12 \(UTC\)/);
  assert.match(md, /## Goal\nSort by activation date/);
  assert.match(md, /## Triage note\nNext sprint$/);
});

test('[UX-01] the overlay uses tokens only, is exported by the shell and sits in the top-right slot of the app shell', () => {
  const src = readFileSync(new URL('../src/ui/SuggestChanges.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,6}\b|rgba?\(/);
  assert.doesNotMatch(src, /style=\{\{[^}]*(color|background|font)/, 'inline styles only for positions');
  assert.match(src, /\.modal-backdrop \.modal/, 'an open dialog is numbered on its own');
  assert.match(src, /addEventListener\('keydown', onKey, true\)/, 'Esc leaves suggestion mode before the dialog sees it');
  const css = readFileSync(new URL('../src/shell.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('/* Suggest changes'));
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,6}\b|rgba?\(/);
  assert.match(block, /\.suggest-label \{ display: none; \}/, 'icon only on phones');
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(index, /SuggestChanges\.tsx/);
  assert.match(readFileSync(new URL('../src/AppShell.tsx', import.meta.url), 'utf8'), /className="shell-actions/);
});
