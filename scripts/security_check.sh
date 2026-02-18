#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[security] compile + test contracts"
(
  cd "$ROOT_DIR/packages/contracts"
  npm run compile >/dev/null
  npm test >/dev/null
)

echo "[security] compile Python sources"
python3 -m compileall "$ROOT_DIR/apps/api" "$ROOT_DIR/services" >/dev/null

echo "[security] verify .local-secrets is not tracked"
if git -C "$ROOT_DIR" ls-files .local-secrets | grep -q .; then
  echo "[security] FAIL: tracked file found under .local-secrets/"
  git -C "$ROOT_DIR" ls-files .local-secrets
  exit 1
fi

echo "[security] optional slither static analysis"
if command -v slither >/dev/null 2>&1; then
  (
    cd "$ROOT_DIR/packages/contracts"
    slither ./contracts --exclude naming-convention,solc-version
  )
else
  echo "[security] SKIP: slither is not installed in this environment"
fi

echo "[security] completed"
