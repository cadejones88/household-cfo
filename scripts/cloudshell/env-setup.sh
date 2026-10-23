#!/usr/bin/env bash
# One-time setup after an environment's first deploy (runbook steps 8.3, 5.2, 6.4, 9 and 9b), run by Cade in Azure
# Cloud Shell (Bash) from a clone of this repo:
#
#   bash scripts/cloudshell/env-setup.sh pilot [--cade-oid <object id in the family tenant>]
#
# Every step checks first and skips what is already done, so it is safe to run again. Steps that change access
# (vault roles, the BC registration's certificate, the database firewall, database roles) ask before they act.
# The only secret it touches is the Plaid secret, which you type at a hidden prompt; it goes straight into Key Vault
# and is never echoed, logged or written to a file. Nothing here prints a secret.
set -euo pipefail

ENV="${1:-}"
[[ "$ENV" == "dev" || "$ENV" == "pilot" ]] || { echo "Usage: bash scripts/cloudshell/env-setup.sh <dev|pilot> [--cade-oid <guid>]"; exit 2; }
shift
CADE_OID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cade-oid) CADE_OID="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 2 ;;
  esac
done

RG="rg-homestead-$ENV"
PG="psql-homestead-$ENV"
PGFQDN="$PG.postgres.database.azure.com"
API="homestead-$ENV-api"
HOUSEHOLD="Cade & Vanessa Jones Family"
PLAID_SECRET_NAME=$([[ "$ENV" == "pilot" ]] && echo "plaid-production-secret" || echo "plaid-sandbox-secret")
BC_CERT_NAME="bc-sandbox-client-cert"
BC_APP_NAME="Homestead BC Sandbox"

step() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok: %s\n' "$*"; }
ask() { local a; read -r -p "   $1 [y/N] " a; [[ "$a" == "y" || "$a" == "Y" ]]; }

ME_UPN=$(az ad signed-in-user show --query userPrincipalName -o tsv)
ME_ID=$(az ad signed-in-user show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
KV=$(az keyvault list -g "$RG" --query "[0].name" -o tsv)
KV_ID=$(az keyvault show -n "$KV" --query id -o tsv)
echo "Environment $ENV · resource group $RG · vault $KV · database $PGFQDN · signed in as $ME_UPN"

# 1. Key Vault data roles for you (Owner manages the vault but cannot read or write what is inside it).
step "1. Key Vault Certificates Officer and Secrets Officer for you on $KV"
need_roles=()
for role in "Key Vault Certificates Officer" "Key Vault Secrets Officer"; do
  if [[ -n "$(az role assignment list --assignee "$ME_ID" --scope "$KV_ID" --role "$role" --query '[0].id' -o tsv)" ]]; then ok "$role already assigned"; else need_roles+=("$role"); fi
done
if [[ ${#need_roles[@]} -gt 0 ]]; then
  if ask "Assign ${need_roles[*]} to $ME_UPN on $KV?"; then
    for role in "${need_roles[@]}"; do az role assignment create --assignee-object-id "$ME_ID" --assignee-principal-type User --role "$role" --scope "$KV_ID" -o none; ok "assigned $role"; done
    echo "   Waiting for the new roles to take effect (up to 5 minutes)…"
    for _ in $(seq 1 30); do az keyvault secret list --vault-name "$KV" -o none 2>/dev/null && break; sleep 10; done
  else
    echo "   Skipped; the next steps need these roles."; exit 1
  fi
fi

# 2. The BC certificate, generated inside Key Vault so its private key never exists as a file; the public half goes
#    on the "Homestead BC Sandbox" registration next to dev's.
step "2. $BC_CERT_NAME in $KV and its public half on \"$BC_APP_NAME\""
if az keyvault certificate show --vault-name "$KV" -n "$BC_CERT_NAME" -o none 2>/dev/null; then
  ok "certificate already in the vault"
else
  policy=$(mktemp)
  cat >"$policy" <<'JSON'
{ "issuerParameters": { "name": "Self" },
  "keyProperties": { "exportable": true, "keySize": 2048, "keyType": "RSA", "reuseKey": false },
  "secretProperties": { "contentType": "application/x-pem-file" },
  "x509CertificateProperties": { "subject": "CN=homestead-bc-sandbox", "validityInMonths": 12, "keyUsage": ["digitalSignature", "keyEncipherment"] },
  "lifetimeActions": [ { "action": { "actionType": "EmailContacts" }, "trigger": { "daysBeforeExpiry": 30 } } ] }
JSON
  az keyvault certificate create --vault-name "$KV" -n "$BC_CERT_NAME" -p @"$policy" -o none
  rm -f "$policy"
  ok "generated (self-signed, CN=homestead-bc-sandbox, 12 months, PEM)"
fi
APP_ID=$(az ad app list --display-name "$BC_APP_NAME" --query "[0].appId" -o tsv)
THUMB=$(az keyvault certificate show --vault-name "$KV" -n "$BC_CERT_NAME" --query x509ThumbprintHex -o tsv)
if [[ -z "$APP_ID" ]]; then
  echo "   Could not find the app registration \"$BC_APP_NAME\"; upload the CER by hand (runbook 5.2)."
elif THUMB_B64=$(python3 -c 'import sys,base64; print(base64.b64encode(bytes.fromhex(sys.argv[1])).decode())' "$THUMB") \
  && [[ -n "$THUMB" && -n "$THUMB_B64" ]] \
  && az ad app credential list --id "$APP_ID" --cert --query "[].customKeyIdentifier" -o tsv | grep -qiF -e "$THUMB" -e "$THUMB_B64"; then
  ok "public certificate already on the registration"
else
  if ask "Add this vault's certificate (thumbprint $THUMB) to \"$BC_APP_NAME\", keeping its existing ones?"; then
    # The download refuses to overwrite a file, so it goes into a fresh directory.
    cerdir=$(mktemp -d)
    az keyvault certificate download --vault-name "$KV" -n "$BC_CERT_NAME" -e PEM -f "$cerdir/cert.pem"
    az ad app credential reset --id "$APP_ID" --cert "@$cerdir/cert.pem" --append -o none
    rm -rf "$cerdir"
    ok "added"
  fi
fi

# 3. The Plaid secret, typed at a hidden prompt and written straight into the vault.
step "3. $PLAID_SECRET_NAME in $KV"
if az keyvault secret show --vault-name "$KV" -n "$PLAID_SECRET_NAME" --query id -o none 2>/dev/null; then
  ok "already in the vault (to replace it, run: az keyvault secret set … by hand)"
else
  read -rs -p "   Paste the Plaid ${ENV/pilot/Production} secret (hidden; Enter alone skips): " s; echo
  if [[ -n "$s" ]]; then
    az keyvault secret set --vault-name "$KV" -n "$PLAID_SECRET_NAME" --file <(printf '%s' "$s") -o none
    ok "stored ($(printf '%s' "$s" | wc -c | tr -d ' ') characters)"
  else
    echo "   Skipped."
  fi
  unset s
fi

# 4. A firewall opening for this Cloud Shell session, then the database work as you (an Entra administrator).
step "4. Database firewall opening for this Cloud Shell"
MYIP=$(curl -s https://api.ipify.org)
RULE="cloudshell-$(date +%Y%m%d)"
if az postgres flexible-server firewall-rule show -g "$RG" --server-name "$PG" --name "$RULE" -o none 2>/dev/null; then
  az postgres flexible-server firewall-rule update -g "$RG" --server-name "$PG" --name "$RULE" --start-ip-address "$MYIP" --end-ip-address "$MYIP" -o none
  ok "rule $RULE now allows $MYIP"
elif ask "Allow this Cloud Shell's address ($MYIP) through $PG's firewall as rule $RULE? (step 9 removes it)"; then
  az postgres flexible-server firewall-rule create -g "$RG" --server-name "$PG" --name "$RULE" --start-ip-address "$MYIP" --end-ip-address "$MYIP" -o none
  ok "added"
else
  echo "   Skipped; the database steps cannot run."; exit 1
fi

export PGPASSWORD
PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)
export PGSSLMODE=require
ME_ENC=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$ME_UPN")
export DATABASE_URL="postgres://$ME_ENC@$PGFQDN:5432/homestead"

step "5. Packages (api and shared only)"
npx -y pnpm@10.28.0 install --frozen-lockfile --filter "@homestead/api..." >/dev/null
npx -y pnpm@10.28.0 --filter @homestead/shared build >/dev/null
ok "installed and built"

step "6. Migrations"
npx -y pnpm@10.28.0 --filter @homestead/api db:migrate

step "7. Database roles for the API and jobs identities (homestead_app only)"
API_IDN="id-homestead-$ENV-api"; JOBS_IDN="id-homestead-$ENV-jobs"
API_OID=$(az identity show -g "$RG" -n "$API_IDN" --query principalId -o tsv)
JOBS_OID=$(az identity show -g "$RG" -n "$JOBS_IDN" --query principalId -o tsv)
missing=$(psql "host=$PGFQDN dbname=postgres user=$ME_UPN sslmode=require" -Atc "select string_agg(n, ' ') from unnest(array['$API_IDN','$JOBS_IDN']) n where not exists (select 1 from pg_roles where rolname = n)")
if [[ -n "$missing" ]]; then
  if ask "Create database logins for $missing (managed identities, no password) and give both the homestead_app role?"; then
    for n in $missing; do
      oid=$([[ "$n" == "$API_IDN" ]] && echo "$API_OID" || echo "$JOBS_OID")
      psql "host=$PGFQDN dbname=postgres user=$ME_UPN sslmode=require" -v ON_ERROR_STOP=1 -qc "select * from pgaadauth_create_principal_with_oid('$n', '$oid', 'service', false, false);" >/dev/null
      ok "login $n"
    done
  fi
else
  ok "both logins exist"
fi
psql "host=$PGFQDN dbname=homestead user=$ME_UPN sslmode=require" -v ON_ERROR_STOP=1 -qc "grant homestead_app to \"$API_IDN\", \"$JOBS_IDN\";" && ok "homestead_app granted"

step "8. The household and your sign-in"
BC_COMPANY_ID=$(az containerapp show -g "$RG" -n "$API" --query "properties.template.containers[0].env[?name=='BC_COMPANY_ID'].value | [0]" -o tsv)
BC_TENANT_ID=$(az containerapp show -g "$RG" -n "$API" --query "properties.template.containers[0].env[?name=='BC_TENANT_ID'].value | [0]" -o tsv)
BC_TENANT_ID=${BC_TENANT_ID:-$TENANT_ID}
BC_TENANT_ID="$BC_TENANT_ID" BC_COMPANY_ID="$BC_COMPANY_ID" BC_CERT_SECRET_REF="$BC_CERT_NAME" npx -y pnpm@10.28.0 --filter @homestead/api db:seed
if [[ -n "$CADE_OID" ]]; then
  npx -y pnpm@10.28.0 --filter @homestead/api db:link-member -- --member Cade --object-id "$CADE_OID" --household "$HOUSEHOLD"
else
  echo "   No --cade-oid given; link your sign-in later with db:link-member (runbook 9b)."
fi
unset PGPASSWORD

step "9. Restart the API so it reads the vault, and close the firewall opening"
REV=$(az containerapp show -g "$RG" -n "$API" --query properties.latestReadyRevisionName -o tsv 2>/dev/null || true)
if [[ -n "$REV" ]]; then az containerapp revision restart -g "$RG" -n "$API" --revision "$REV" -o none && ok "restarted $REV"; else echo "   No API revision yet (deploy first)."; fi
if ask "Remove firewall rule $RULE now?"; then az postgres flexible-server firewall-rule delete -g "$RG" --server-name "$PG" --name "$RULE" --yes -o none; ok "removed"; fi

printf '\nDone for %s. Still by hand: add the %s Console address to homestead-console'"'"'s redirect URIs (family tenant), then sign in.\n' "$ENV" "$ENV"
