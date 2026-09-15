#!/usr/bin/env bash
# Verifies the security fixes in commits b466c0b / ce05cff / f55e2a3 are
# actually live on the deployed backend. Read-only: it logs in, reads two
# endpoints and writes nothing.
#
#   bash scripts/verify-deploy.sh [API_BASE]
#
# API_BASE defaults to the production backend.

set -uo pipefail
API="${1:-https://bamboo-os-backend.onrender.com/api}"
pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
info() { printf '        %s\n' "$1"; }

echo "Checking $API"
echo

# 1 ── the service is up at all
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$API/health")
if [ "$code" = "200" ]; then ok "service is up (/health 200)"
else bad "service did not answer 200 on /health (got $code)"
     info "On Render's free/starter tier the first request after idle can take ~50s."
     echo; echo "Stopping — nothing else can be checked until it responds."; exit 1
fi

# 2 ── log in
read -r -p "Admin email: " EMAIL
read -r -s -p "Password: " PASSWORD; echo; echo
login=$(curl -s --max-time 60 -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$(printf '{"email":%s,"password":%s}' \
        "$(printf '%s' "$EMAIL"    | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
        "$(printf '%s' "$PASSWORD" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")")
TOKEN=$(printf '%s' "$login" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -n "$TOKEN" ]; then ok "login succeeded"
else bad "login failed"; info "$(printf '%s' "$login" | head -c 200)"; exit 1
fi
AUTH="Authorization: Bearer $TOKEN"

# 3 ── ce05cff: integration API keys must not come back over the wire
settings=$(curl -s --max-time 60 -H "$AUTH" "$API/settings")
result=$(printf '%s' "$settings" | python3 -c '
import json,sys
try: s=json.load(sys.stdin)
except Exception: print("UNREADABLE"); sys.exit()
ints=s.get("integrations") or []
leaked=[i.get("id","?") for i in ints if "apiKey" in i]
flagged=[i.get("id","?") for i in ints if "hasApiKey" in i]
print("LEAK:"+",".join(leaked) if leaked else ("REDACTED:%d"%len(flagged) if flagged else "NO_INTEGRATIONS"))')
case "$result" in
  REDACTED:*) ok "integration API keys are redacted (${result#REDACTED:} integrations, hasApiKey only)" ;;
  LEAK:*)     bad "apiKey STILL EXPOSED on /settings for: ${result#LEAK:}"
              info "ce05cff is not live — the old revision is still serving." ;;
  *)          bad "could not read /settings ($result)" ;;
esac

# 4 ── migrations 0057-0060: the Poki estimate routes must exist
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -H "$AUTH" "$API/poki/estimates")
case "$code" in
  200|403) ok "migrations 0057-0060 are live (/poki/estimates answered $code, not 404)" ;;
  404)     bad "/poki/estimates returned 404 — the new routes/migrations are NOT deployed" ;;
  *)       bad "/poki/estimates returned $code (expected 200, or 403 without poki.manage)" ;;
esac

echo
printf 'passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
