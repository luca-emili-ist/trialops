// Converts the CMP-06 credibility dataset delivered as Word/Excel (Master Protocol .docx, sponsor .docx per case folder,
// reference workbook .xlsx with the twelve tabs) into the machine format of services/ai-runtime/datasets/README.md
// (manifest.json + cases/<case_id>_*.json). No dependencies: the .docx/.xlsx parts are read with the `unzip` CLI.
// Usage: node scripts/cmp06-convert.mjs <source dir> <output dir> --dataset-id <id> --author "<..>" [--checker "<..>"]
//          [--created-on YYYY-MM-DD] [--kind credibility_dataset|harness_fixture] [--check-only]
// The provenance written is exactly what is passed: an empty checker or independence attestation stays empty, so the
// harness reports the run as not evidence (CMP-07). The source folder is only read.
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { datasetSha256 } from '../services/ai-runtime/src/credibility.ts';
import { normaliseText } from '../services/ai-runtime/src/citation.ts';

const args = process.argv.slice(2);
const opt = (k, d = '') => (args.includes(k) ? args[args.indexOf(k) + 1] ?? d : d);
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [srcArg, outArg] = positional;
if (!srcArg || !outArg) {
  console.error('usage: node scripts/cmp06-convert.mjs <source dir> <output dir> --dataset-id <id> --author "<..>" [--checker "<..>"]');
  process.exit(2);
}
const src = resolve(srcArg); const out = resolve(outArg);

// ---------- OOXML readers ----------
const unzipPart = (file, part) => execFileSync('unzip', ['-p', file, part], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const decode = s => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e]
  ?? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));

/** Paragraphs of word/document.xml (text runs joined; <w:tab/> → tab, <w:br/> → line break), empty ones dropped. */
export function docxParagraphs(file) {
  const xml = unzipPart(file, 'word/document.xml');
  const body = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');          // deleted revisions are not part of the text
  const paras = body.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) ?? [];
  return paras.map(p => {
    let t = '';
    for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t\/>|<w:tab\/>|<w:br\b[^>]*\/>/g)) {
      if (m[0].startsWith('<w:tab')) t += '\t';
      else if (m[0].startsWith('<w:br')) t += '\n';
      else if (m[1] !== undefined) t += decode(m[1]);
    }
    return t.trim();
  }).filter(t => t.length > 0);
}
const docxText = file => docxParagraphs(file).join('\n\n');

/** Sheets of an .xlsx as arrays of row objects keyed by the header row (inline, shared and plain strings). */
export function xlsxSheets(file) {
  const wb = unzipPart(file, 'xl/workbook.xml');
  const rels = unzipPart(file, 'xl/_rels/workbook.xml.rels');
  let shared = [];
  try {
    const sst = unzipPart(file, 'xl/sharedStrings.xml');
    shared = (sst.match(/<(?:x:)?si>[\s\S]*?<\/(?:x:)?si>/g) ?? []).map(si => [...si.matchAll(/<(?:x:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:x:)?t>/g)].map(m => decode(m[1])).join(''));
  } catch { /* no shared strings */ }
  const target = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/>/g)].map(m => {
    const a = m[1]; return [/Id="([^"]+)"/.exec(a)[1], /Target="([^"]+)"/.exec(a)[1].replace(/^\//, '').replace(/^(?!xl\/)/, 'xl/')];
  }));
  const colIdx = ref => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const sheets = {};
  for (const m of wb.matchAll(/<(?:x:)?sheet\b([^>]*)\/>/g)) {
    const name = decode(/name="([^"]*)"/.exec(m[1])[1]);
    const rid = /r:id="([^"]+)"/.exec(m[1])[1];
    const xml = unzipPart(file, target.get(rid));
    const rows = (xml.match(/<(?:x:)?row\b[\s\S]*?<\/(?:x:)?row>/g) ?? []).map(row => {
      const cells = [];
      for (const c of row.matchAll(/<(?:x:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:x:)?c>)/g)) {
        const attrs = c[1]; const inner = c[2] ?? '';
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1]; const type = /t="([^"]+)"/.exec(attrs)?.[1];
        let v = '';
        if (type === 'inlineStr') v = [...inner.matchAll(/<(?:x:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:x:)?t>/g)].map(x => decode(x[1])).join('');
        else {
          const raw = /<(?:x:)?v>([\s\S]*?)<\/(?:x:)?v>/.exec(inner)?.[1];
          v = raw === undefined ? '' : type === 's' ? shared[Number(raw)] : decode(raw);
        }
        cells[ref ? colIdx(ref) : cells.length] = v;
      }
      return Array.from(cells, x => x ?? '');
    });
    const [head = [], ...body] = rows;
    sheets[name] = body.filter(r => r.some(x => String(x).trim() !== '')).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
  }
  return sheets;
}

// ---------- mapping to the machine format ----------
const col = (row, prefix) => {                                  // header lookup tolerant of "(...)" hints in the header
  const k = Object.keys(row).find(h => h === prefix || h.split(/\s*\(/)[0].trim() === prefix);
  return k === undefined ? '' : row[k];
};
const yes = v => /^(y|yes|true|1)$/i.test(String(v).trim());
const kw = v => String(v ?? '').split(/[;|]/).map(x => x.trim()).filter(Boolean);
const byCase = (rows, id) => (rows ?? []).filter(r => col(r, 'case_id') === id);

if (args.includes('--dump-headers')) {
  const sh = xlsxSheets(join(src, 'reference-and-traps_v1.0.xlsx'));
  for (const [n, rows] of Object.entries(sh)) console.log(n, rows.length, JSON.stringify(Object.keys(rows[0] ?? {})), JSON.stringify(rows[0]));
  process.exit(0);
}
if (args.includes('--dump')) {
  const sh = xlsxSheets(join(src, 'reference-and-traps_v1.0.xlsx'));
  for (const n of opt('--dump').split(',')) for (const r of sh[n]) console.log(n, JSON.stringify(Object.values(r)));
  process.exit(0);
}

// Trap keywords (T1-T4): taken from the Traps tab column `keywords` when the dataset author supplies it. Otherwise these
// CONVERTER ASSUMPTIONS apply (not from the independent author, to be confirmed by the clinical checker): each names what
// is specific to that trap, so a generic warning does not count (dataset README: "a generic warning is insufficient").
// The T3 set was broadened after the v1 pilot showed a correct warning worded "no sponsor-defined endpoint" (post hoc,
// declared in docs/ai/evidence/protocol.appendix.draft/PILOT_2026-10-18.md).
const TRAP_KEYWORDS = {
  T1: row => [...new Set([...`${col(row, 'expected flag')}`.matchAll(/\b\d+(?:\.\d+)?\s?mg\b/g)].map(m => m[0]))],
  T2: row => (/twice daily/i.test(col(row, 'expected flag')) ? ['twice daily', 'twice-daily'] : []),
  T3: () => ['primary endpoint', 'no endpoint', 'endpoint is missing', 'missing endpoint', 'no endpoints', 'endpoint not defined',
    'no defined endpoint', 'no sponsor-defined endpoint', 'without an endpoint', 'endpoint or timeframe', 'no endpoint or timeframe'],
  T4: row => {
    const f = col(row, 'expected flag');
    const k = [];
    for (const m of f.matchAll(/\b(\d+) to (\d+) years\b/g)) k.push(`${m[1]} to ${m[2]}`, `${m[1]}-${m[2]}`, `${m[1]}–${m[2]}`);
    for (const m of f.matchAll(/\b(\d+)(?:-| )days?\b/g)) k.push(`${m[1]} days`, `${m[1]}-day`);
    return [...new Set(k)];
  },
};
// Silent tab "<Section>[.<type|level>]: none — documents silent" → reference.silent (F2).
function silentEntry(caseId, text, i) {
  const what = text.split(':')[0].trim();
  const [sec, sub] = what.split('.').map(s => s.trim());
  const s = sec.toLowerCase();
  if (s.startsWith('visits')) return { id: `${caseId}-F2-${i}`, section: 'schedule.visits', description: text };
  if (s.startsWith('endpoints')) return { id: `${caseId}-F2-${i}`, section: 'endpoints', ...(sub ? { where: { type: sub } } : {}), description: text };
  if (s.startsWith('objectives')) return { id: `${caseId}-F2-${i}`, section: 'objectives', ...(sub ? { where: { level: sub } } : {}), description: text };
  throw new Error(`Silent row of ${caseId} not mapped: ${text}`);
}
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const book = join(src, 'reference-and-traps_v1.0.xlsx');
const sh = xlsxSheets(book);
const mpFile = readdirSync(join(src, '00_master-protocol')).find(f => f.endsWith('.docx'));
const mpParas = docxParagraphs(join(src, '00_master-protocol', mpFile));
const mpRef = basename(mpFile).split('_')[0];
// The agent receives master_protocol as an object (packages/api/src/agents/index.ts passes the approved USDM). The
// delivered Master Protocol is a Word excerpt, so it is given as { ref, title, version, text } with the full text.
const masterProtocol = { ref: mpRef, title: mpParas[0], version: '1.0', text: mpParas.join('\n\n') };
const docTexts = new Map([[mpRef, masterProtocol.text]]);

const problems = []; const cases = [];
const listed = new Set();
for (const arm of sh.Arms) {
  const id = col(arm, 'case_id');
  const docs = byCase(sh.Documents, id).map(d => {
    const file = join(src, col(d, 'file name')); listed.add(resolve(file));
    if (!existsSync(file)) { problems.push(`${id}: missing ${col(d, 'file name')}`); return null; }
    const ref = col(d, 'ref');
    if (!basename(file).startsWith(`${ref}_`)) problems.push(`${id}: file ${basename(file)} does not start with ref ${ref}`);
    const text = docxText(file); docTexts.set(ref, text);
    return { ref, title: col(d, 'title'), text };
  }).filter(Boolean);
  const syn = byCase(sh.Synopsis, id)[0] ?? {};
  const trapsRaw = byCase(sh.Traps, id).filter(t => col(t, 'type') !== 'F2');
  const traps = [];
  for (const t of trapsRaw) {                    // T1/T2 have two rows (one per source statement): one trap per case/type
    const type = col(t, 'type');
    const prev = traps.find(x => x.type === type);
    const quoted = `${col(t, 'ref')}: "${col(t, 'quoted sentence(s)')}"`;
    if (prev) { prev.description += ` | ${quoted}`; continue; }
    const authorKw = kw(col(t, 'keywords'));
    traps.push(type === 'F1'
      // F1 targets: the reference items the expected flag says to retain ("retain EX1"), a converter reading of the flag.
      ? { id: `${id}-F1`, type, description: `${col(t, 'expected flag')} | ${quoted}`, keywords: [], forbidden: authorKw,
        targets: [...col(t, 'expected flag').matchAll(/\bretain ((?:OBJ|EP|IN|EX|INT)\d+)/g)].map(m => m[1]) }
      : { id: `${id}-${type}`, type, description: `${col(t, 'expected flag')} | ${quoted}`,
        keywords: authorKw.length ? authorKw : TRAP_KEYWORDS[type](t), forbidden: [] });
  }
  for (const t of traps) if (t.type !== 'F1' && !t.keywords.length) problems.push(`${id}: trap ${t.id} has no keywords`);
  for (const t of traps) if (t.type === 'F1' && !t.targets.length) problems.push(`${id}: F1 ${t.id} names no item to retain`);
  const c = {
    case_id: id,
    data_class: 'CONFIDENTIAL_SPONSOR',
    input: {
      master_protocol: masterProtocol,
      arm: {
        code: col(arm, 'arm_code'), name: col(arm, 'arm_name'), intervention_type: col(arm, 'intervention_type'),
        has_prior_human_data: yes(col(arm, 'has_prior_human_data')), approved_any_indication: yes(col(arm, 'approved_any_indication')),
        sponsor: col(arm, 'sponsor'),
      },
      sponsor_documents: docs,
    },
    reference: {
      synopsis: { phase: col(syn, 'phase') },
      objectives: byCase(sh.Objectives, id).map(r => ({ id: col(r, 'id'), level: col(r, 'level'), text: col(r, 'text'), keywords: kw(col(r, 'keywords')), mandatory: yes(col(r, 'mandatory')) })),
      endpoints: byCase(sh.Endpoints, id).map(r => ({ id: col(r, 'id'), type: col(r, 'type'), text: col(r, 'text'), keywords: kw(col(r, 'keywords')), mandatory: yes(col(r, 'mandatory')) })),
      criteria: byCase(sh.Criteria, id).map(r => ({ id: col(r, 'id'), kind: col(r, 'inclusion/exclusion'), text: col(r, 'text'), keywords: kw(col(r, 'keywords')), mandatory: yes(col(r, 'mandatory')) })),
      // id INT1.. in row order and role from the type column: converter assignment, matched by role (README conventions)
      interventions: byCase(sh.Interventions, id).map((r, i) => ({ id: col(r, 'id') || `INT${i + 1}`, name: col(r, 'name'),
        role: col(r, 'type') === 'placebo' ? 'placebo' : 'active', dose: col(r, 'dose'), mandatory: yes(col(r, 'mandatory')) })),
      visits: byCase(sh.Visits, id).map(r => ({ name: col(r, 'name'), day: Number(col(r, 'day')), mandatory: false })),
      quotes: byCase(sh.Quotes, id).map(r => ({ item: col(r, 'item_id'), ref: col(r, 'ref'), quote: col(r, 'verbatim sentence') })),
      consistency: byCase(sh.Consistency, id).map(r => ({ check: col(r, 'check'), expected: col(r, 'expected result'), keywords: [] })),
      traps,
      silent: byCase(sh.Silent, id).map((r, i) => silentEntry(id, col(r, 'section left silent on purpose'), i + 1)),
    },
  };
  cases.push({ file: `${id}_${slug(c.input.arm.code)}_${slug(c.input.arm.name.split(' ')[0])}.json`, case: c });
}
for (const d of readdirSync(src).filter(d => /^C\d+$/.test(d))) {
  for (const f of readdirSync(join(src, d)).filter(f => f.endsWith('.docx'))) if (!listed.has(resolve(join(src, d, f)))) problems.push(`${d}/${f} not listed in Documents`);
}

// Quote check: every Quotes row must be found verbatim (whitespace-normalised, case sensitive, as citation.ts) in its ref.
let qOk = 0; const qBad = [];
for (const { case: c } of cases) for (const q of c.reference.quotes) {
  const t = docTexts.get(q.ref);
  if (t !== undefined && normaliseText(t).includes(normaliseText(q.quote))) qOk++;
  else qBad.push(`${c.case_id} ${q.item} ${q.ref}: ${t === undefined ? 'unknown ref' : 'not verbatim'}: ${q.quote.slice(0, 80)}`);
}
for (const t of sh.Traps) {                       // trap anchors (T1-T4, F1, F2) must be in the documents too
  const txt = docTexts.get(col(t, 'ref'));
  for (const sent of col(t, 'quoted sentence(s)').split(/(?<=\.)\s+(?=[A-Z])/)) {
    if (txt !== undefined && normaliseText(txt).includes(normaliseText(sent))) qOk++;
    else qBad.push(`${col(t, 'case_id')} trap ${col(t, 'type')} ${col(t, 'ref')}: not verbatim: ${sent.slice(0, 80)}`);
  }
}
const nq = qOk + qBad.length;
console.log(`cases ${cases.length}, sponsor documents ${cases.reduce((a, c) => a + c.case.input.sponsor_documents.length, 0)}, master protocol ${mpRef} (${masterProtocol.text.length} chars)`);
console.log(`quotes (Quotes tab + Traps anchors) found verbatim: ${qOk}/${nq} (${qBad.filter(b => b.includes(mpRef)).length} failures on ${mpRef})`);
for (const b of qBad) console.log(`  quote problem: ${b}`);
for (const p of problems) console.log(`  problem: ${p}`);
const traps = cases.flatMap(c => c.case.reference.traps);
console.log(`traps: ${traps.filter(t => t.type !== 'F1').map(t => `${t.id}[${t.keywords.join('|')}]`).join(' ')}; F1: ${traps.filter(t => t.type === 'F1').map(t => t.id).join(' ')}; silent: ${cases.flatMap(c => c.case.reference.silent).length}`);
if (args.includes('--check-only')) process.exit(qBad.length || problems.length ? 1 : 0);

const manifest = {
  $comment: 'PILOT dataset, NOT evidence. Converted by scripts/cmp06-convert.mjs from an AI-prepared candidate (Codex), unreviewed, unsigned, with no named human author or checker. kind is credibility_dataset only to exercise the real evidence rule: the harness must report it as not evidence (empty checker and independence attestation).',
  format: 'trialops.ai-credibility-dataset/1',
  kind: opt('--kind', 'credibility_dataset'),
  dataset_id: opt('--dataset-id'),
  task_type: 'protocol.appendix.draft',
  version: opt('--version', '1.0'),
  synthetic: true,
  source_workbook: basename(book),
  provenance: {
    author: opt('--author'), checker: opt('--checker'), created_on: opt('--created-on'),
    independence: { statement: opt('--statement'), attested_by: opt('--attested-by'), attested_on: opt('--attested-on') },
  },
  sha256: datasetSha256(cases),
};
rmSync(join(out, 'cases'), { recursive: true, force: true });
mkdirSync(join(out, 'cases'), { recursive: true });
for (const c of cases) writeFileSync(join(out, 'cases', c.file), JSON.stringify(c.case, null, 2) + '\n');
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`written ${out} (sha256 ${manifest.sha256})`);
process.exit(qBad.length || problems.length ? 1 : 0);
