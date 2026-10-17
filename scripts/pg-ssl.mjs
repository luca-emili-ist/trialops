// TLS options for pg connections to Supabase: verify the server against the Supabase Root 2021 CA
// (public certificate, downloaded from Supabase; valid until 2031-04-26) instead of accepting any certificate.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const supabaseSsl = {
  ca: readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'supabase-root-2021-ca.crt'), 'utf8'),
  rejectUnauthorized: true,
};
