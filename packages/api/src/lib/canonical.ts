// Canonical JSON (sorted keys) and sha256: the hash a signature binds to (CMP-02).
import { createHash } from 'node:crypto';

export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
export const contentHash = (v: unknown): string => sha256(canonical(v));
