// Single list of test files, shared by the test runner (scripts/db.mjs) and the traceability matrix (scripts/trace.mjs).
// db/tests/*.test.mjs plus <workspace>/test/**/*.test.{mjs,ts} of every workspace (packages, services, apps, examples).
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const isTest = f => /\.test\.(mjs|ts|tsx)$/.test(f);
function walk(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : isTest(f) ? [p] : [];
  });
}
export function testFiles(root) {
  const files = walk(join(root, 'db/tests'));
  for (const group of ['packages', 'services', 'apps', 'examples']) {
    if (!existsSync(join(root, group))) continue;
    for (const ws of readdirSync(join(root, group))) {
      const t = join(root, group, ws, 'test');
      if (existsSync(t)) files.push(...walk(t));
    }
  }
  return files.sort();
}
export const rel = (root, f) => relative(root, f);
