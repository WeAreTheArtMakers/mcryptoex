# mCryptoEx RUNBOOK

Date: 2026-02-18

## 1) Canonical docs path check

- Architecture document path is `docs/ARCHITECTURE.md` (not root `ARCHITECTURE.md`).

## 2) Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)
- Node.js 20+
- npm 10+
- Python 3.11+

## 3) One-command local start

macOS / Linux:

```bash
cp .env.example .env
docker compose up --build
```

Windows (PowerShell):

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Core endpoints:

- Web: `http://localhost:3300`
- API: `http://localhost:8500`
- Grafana: `http://localhost:3400`
- Redpanda Console: `http://localhost:8088`

## 4) BuildKit fallback

If Docker stalls at `node:20-alpine` metadata:

macOS / Linux:

```bash
DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose up --build
```

Windows (PowerShell):

```powershell
$env:DOCKER_BUILDKIT="0"
$env:COMPOSE_DOCKER_CLI_BUILD="0"
docker compose up --build
```

## 5) Phase checks

Contracts:

```bash
cd packages/contracts
npm install
npm test
```

Web build:

```bash
npm run web:build
```

Tempo pipeline smoke (swap note -> validator -> ledger -> analytics):

```bash
python3 scripts/e2e_pipeline_check.py
```

Phase 5 security check bundle:

```bash
./scripts/security_check.sh
```

Phase 6 chain-registry + cross-chain check bundle:

```bash
npm run check:phase6
```

## 6) Generate chain registry

Token/chain/indexer config is generated from deployment registries:

```bash
python3 scripts/generate_chain_registry.py
```

Output:

- `packages/sdk/data/chain-registry.generated.json`

This file drives:

- Tempo API `/tokens` and `/risk/assumptions`
- indexer worker chain settings via `INDEXER_CHAIN_KEY`

## 7) Testnet deployment (Movement 2 baseline)

Set values in `packages/contracts/.env`:

- `PRIVATE_KEY`
- `SEPOLIA_RPC_URL` (for Ethereum Sepolia)
- `BSC_TESTNET_RPC_URL` (for BNB testnet)

Deploy:

```bash
cd packages/contracts
npm run deploy:sepolia
npm run deploy:bscTestnet
```

Address registries are written to `packages/contracts/deploy/address-registry.<network>.json`.

## 8) Timelock/multisig-ready admin handoff

After deployment, assign governance ownership/roles to your timelock or multisig:

```bash
cd packages/contracts
NEW_ADMIN_ADDRESS=0xYourTimelockOrSafe \
ADDRESS_REGISTRY_PATH=./deploy/address-registry.sepolia.json \
npm run handoff:admin -- --network sepolia
```

Optional hard cutover (revokes deployer roles):

```bash
REVOKE_DEPLOYER_ROLES=true \
NEW_ADMIN_ADDRESS=0xYourTimelockOrSafe \
ADDRESS_REGISTRY_PATH=./deploy/address-registry.sepolia.json \
npm run handoff:admin -- --network sepolia
```

Then call `acceptOwnership()` on `HarmonyFactory` and `HarmonyRouter` from the new admin.

## 9) Secrets and local wallets

- Never commit private keys.
- Keep local-only keys in `.local-secrets/` (already gitignored).
- Verify no secret files are tracked:

```bash
git ls-files .local-secrets
```

The command should print nothing.

## 10) Stop and clean

```bash
docker compose down -v
```
