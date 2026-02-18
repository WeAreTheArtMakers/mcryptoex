#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$ROOT_DIR/packages/sdk/data/chain-registry.generated.json" ]; then
  echo "[security] generating missing chain registry"
  python3 "$ROOT_DIR/scripts/generate_chain_registry.py" >/dev/null
fi

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
  if ! (
    cd "$ROOT_DIR/packages/contracts"
    slither . --compile-force-framework hardhat --exclude naming-convention,solc-version
  ); then
    echo "[security] WARN: slither reported findings (see logs above)"
  fi
elif command -v docker >/dev/null 2>&1; then
  if ! docker run --rm \
    -v "$ROOT_DIR/packages/contracts:/work" \
    -w /work \
    ghcr.io/crytic/slither:latest \
    slither . --compile-force-framework hardhat --exclude naming-convention,solc-version; then
    echo "[security] WARN: dockerized slither reported findings (see logs above)"
  fi
else
  echo "[security] SKIP: slither and docker are unavailable in this environment"
fi

echo "[security] completed"
