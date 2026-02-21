#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-${1:-WeAreTheArtMakers/mcryptoex}}"
DISPATCH="${DISPATCH:-${2:-false}}"

for key in OCI_HOST OCI_USER OCI_SSH_KEY; do
  if [[ -z "${!key:-}" ]]; then
    echo "missing required env: ${key}"
    echo "usage example:"
    echo "  OCI_HOST=1.2.3.4 OCI_USER=ubuntu OCI_SSH_KEY=\"\$(cat ~/.ssh/id_ed25519)\" \\"
    echo "    scripts/deploy/set-gh-oci-secrets.sh ${REPO} true"
    exit 1
  fi
done

: "${OCI_APP_DIR:=~/mcryptoex}"
: "${OCI_REPO_URL:=https://github.com/${REPO}.git}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required"
  exit 1
fi

python3 - <<'PY' >/dev/null
import importlib.util
import sys
if importlib.util.find_spec("nacl") is None:
    print("python package 'pynacl' is required")
    sys.exit(1)
PY

KEY_JSON="$(gh api "repos/${REPO}/actions/secrets/public-key")"
KEY_ID="$(printf '%s' "${KEY_JSON}" | jq -r '.key_id')"
PUB_KEY="$(printf '%s' "${KEY_JSON}" | jq -r '.key')"

set_secret() {
  local name="$1"
  local value="$2"
  local encrypted

  encrypted="$(
    python3 - "${PUB_KEY}" "${value}" <<'PY'
import base64
import sys
from nacl import encoding, public

pub_b64 = sys.argv[1]
secret_value = sys.argv[2].encode()
public_key = public.PublicKey(pub_b64.encode(), encoder=encoding.Base64Encoder())
sealed_box = public.SealedBox(public_key)
encrypted = sealed_box.encrypt(secret_value)
print(base64.b64encode(encrypted).decode())
PY
  )"

  gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    "repos/${REPO}/actions/secrets/${name}" \
    -f encrypted_value="${encrypted}" \
    -f key_id="${KEY_ID}" >/dev/null

  echo "set ${name}"
}

set_secret "OCI_HOST" "${OCI_HOST}"
set_secret "OCI_USER" "${OCI_USER}"
set_secret "OCI_SSH_KEY" "${OCI_SSH_KEY}"
set_secret "OCI_APP_DIR" "${OCI_APP_DIR}"
set_secret "OCI_REPO_URL" "${OCI_REPO_URL}"

if [[ "${DISPATCH}" == "true" ]]; then
  gh api \
    --method POST \
    -H "Accept: application/vnd.github+json" \
    "repos/${REPO}/actions/workflows/deploy-oci-live.yml/dispatches" \
    -f ref="main" >/dev/null
  echo "workflow dispatched: deploy-oci-live (main)"
fi

echo "done"
