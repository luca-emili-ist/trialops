#!/bin/bash
# Creates (or updates) the single admin account of TrialOps on Supabase with the unified login of the Keychain
# ("Unified login (Grant OS + Development apps)"), as platform_admin of PLAT-001. Run it yourself; nothing is printed.
set -euo pipefail
cd "$(dirname "$0")/.."
REF=dbhmlvqrwkurxgeeidko
export SUPABASE_URL="https://$REF.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY=$(supabase projects api-keys --project-ref $REF -o json | python3 -c "import sys,json; print(next(k['api_key'] for k in json.load(sys.stdin) if k.get('name')=='service_role'))")
PW=$(security find-generic-password -s 'Supabase DB TrialOps (InSilicoTrials, eu-central-1)' -w)
export DATABASE_URL="postgresql://postgres.$REF:$PW@aws-1-eu-central-1.pooler.supabase.com:6543/postgres"
export ADMIN_EMAIL=luca.emili@insilicotrials.com
export ADMIN_PASSWORD=$(security find-generic-password -s 'Unified login (Grant OS + Development apps)' -w)
node scripts/supabase-users.mjs admin
