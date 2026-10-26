#!/usr/bin/env bash
# Prepara, UNA vez, el proyecto de GCP donde `deploy-gateway.yml` publica el gateway en Cloud Run.
#
#   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... \
#   LLM_GATEWAY_TOKEN=$(openssl rand -hex 24) \
#     apps/llm-gateway/deploy/setup-gcp.sh <project-id> <billing-account-id>
#
# Crea el proyecto (si no existe), le liga la facturación (Cloud Run no arranca sin ella, aunque
# todo quede dentro del free tier), el registry de imágenes, los dos secretos, las service
# accounts y la federación de identidad con GitHub (sin keys JSON), y deja las variables del repo
# que lee el workflow. Se puede volver a correr: lo que ya existe no se toca, salvo los secretos,
# que reciben una versión nueva si vienen en el entorno.
set -euo pipefail

PROJECT_ID=${1:?uso: setup-gcp.sh <project-id> <billing-account-id>}
BILLING_ACCOUNT=${2:?uso: setup-gcp.sh <project-id> <billing-account-id>}
REGION=${REGION:-us-central1}
GITHUB_REPO=${GITHUB_REPO:-julianjab/ia-flow}

REGISTRY=llm-gateway
DEPLOY_SA=llm-gateway-deploy@${PROJECT_ID}.iam.gserviceaccount.com
RUNTIME_SA=llm-gateway-runtime@${PROJECT_ID}.iam.gserviceaccount.com
POOL=github
PROVIDER=ia-flow

gc() { gcloud --project "$PROJECT_ID" --quiet "$@"; }
step() { printf '\n▸ %s\n' "$*"; }

step "proyecto $PROJECT_ID"
gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1 || gcloud projects create "$PROJECT_ID" --name="llm-gateway"
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" >/dev/null

step "APIs"
gc services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

step "registry $REGISTRY ($REGION)"
gc artifacts repositories describe "$REGISTRY" --location="$REGION" >/dev/null 2>&1 ||
  gc artifacts repositories create "$REGISTRY" --repository-format=docker --location="$REGION"
# El free tier de Artifact Registry es de 0.5 GB: sólo se guardan las dos últimas imágenes.
policy=$(mktemp)
cat >"$policy" <<'JSON'
[
  { "name": "keep-recent", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 2 } },
  { "name": "delete-rest", "action": { "type": "Delete" }, "condition": { "olderThan": "86400s" } }
]
JSON
gc artifacts repositories set-cleanup-policies "$REGISTRY" --location="$REGION" --policy="$policy" --no-dry-run >/dev/null
rm -f "$policy"

step "service accounts"
for sa in llm-gateway-deploy llm-gateway-runtime; do
  gc iam service-accounts describe "$sa@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gc iam service-accounts create "$sa"
done

step "secretos"
put_secret() {
  local name=$1 value=$2
  gc secrets describe "$name" >/dev/null 2>&1 || gc secrets create "$name" --replication-policy=automatic >/dev/null
  if [[ -n $value ]]; then
    printf '%s' "$value" | gc secrets versions add "$name" --data-file=- >/dev/null
    echo "  $name: versión nueva"
  fi
  gc secrets add-iam-policy-binding "$name" --member="serviceAccount:$RUNTIME_SA" \
    --role=roles/secretmanager.secretAccessor >/dev/null
}
put_secret llm-gateway-oauth-token "${CLAUDE_CODE_OAUTH_TOKEN:-}"
put_secret llm-gateway-token "${LLM_GATEWAY_TOKEN:-}"

step "permisos del deploy"
for role in roles/run.admin roles/artifactregistry.writer; do
  gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOY_SA" --role="$role" \
    --condition=None >/dev/null
done
# Para desplegar un servicio que corre como la runtime SA.
gc iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:$DEPLOY_SA" \
  --role=roles/iam.serviceAccountUser >/dev/null

step "federación con GitHub ($GITHUB_REPO)"
gc iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 ||
  gc iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"
# Sólo el workflow de main de ESTE repo puede tomar la identidad del deploy.
gc iam workload-identity-pools providers describe "$PROVIDER" --location=global \
  --workload-identity-pool="$POOL" >/dev/null 2>&1 ||
  gc iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global \
    --workload-identity-pool="$POOL" --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '$GITHUB_REPO' && assertion.ref == 'refs/heads/main'"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
POOL_ID="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL"
gc iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/$POOL_ID/attribute.repository/$GITHUB_REPO" >/dev/null

step "variables del repo"
gh variable set GCP_PROJECT_ID --repo "$GITHUB_REPO" --body "$PROJECT_ID"
gh variable set GCP_REGION --repo "$GITHUB_REPO" --body "$REGION"
gh variable set GCP_WIF_PROVIDER --repo "$GITHUB_REPO" --body "$POOL_ID/providers/$PROVIDER"
gh variable set GCP_DEPLOY_SA --repo "$GITHUB_REPO" --body "$DEPLOY_SA"
gh variable set GCP_RUNTIME_SA --repo "$GITHUB_REPO" --body "$RUNTIME_SA"

printf '\n✓ listo. Corré el workflow "Deploy gateway" (o pusheá a main) para el primer deploy.\n'
