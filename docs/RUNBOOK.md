# mCryptoEx RUNBOOK

Date: 2026-02-19

## 1) Canonical docs path

- Architecture doc is `docs/ARCHITECTURE.md` (not repository root).

## 2) Prerequisites

- Docker Desktop (or Docker Engine + Compose)
- Node.js `20+`
- npm `10+`
- Python `3.11+`

## 3) Local one-command start

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

Endpoints:

- Web: `http://localhost:3300`
- API: `http://localhost:8500`
- Grafana: `http://localhost:3400`
- Redpanda Console: `http://localhost:8088`

## 4) BuildKit fallback (if image metadata stalls)

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

## 5) Contract environment (local-only secrets)

Create `packages/contracts/.env` (gitignored):

```bash
cp packages/contracts/.env.example packages/contracts/.env
```

Minimum fields:

- `PRIVATE_KEY`
- `SEPOLIA_RPC_URL`
- `BSC_TESTNET_RPC_URL`
- `USDC_TOKEN_ADDRESS_*`
- `USDT_TOKEN_ADDRESS_*`

Never commit `packages/contracts/.env`.
Never use Hardhat deterministic test keys on public testnets/mainnet.
Never collect or store end-user private keys in backend/local operator wallets (non-custodial model).

## 6) Contract checks and deploy

```bash
cd packages/contracts
npm install
npm test
npm run deploy:local
```

Testnets:

```bash
npm run deploy:sepolia
npm run deploy:bscTestnet
```

Address outputs:

- `packages/contracts/deploy/address-registry.hardhat.json`
- `packages/contracts/deploy/address-registry.sepolia.json`
- `packages/contracts/deploy/address-registry.bscTestnet.json`

## 7) Gas estimation and funding

Estimate deployment gas profile:

```bash
cd packages/contracts
npm run estimate:deploy:gas
```

Deployer address check:

```bash
cd packages/contracts
node -e "require('dotenv').config(); const {Wallet}=require('ethers'); console.log(new Wallet(process.env.PRIVATE_KEY).address)"
```

Recommended funding before deploy retries (from `estimate:deploy:gas` + safety buffer):

- Sepolia deployer: at least `0.40 ETH`
- BSC testnet deployer: at least `0.50 BNB`

## 8) Liquidity bootstrap (post deploy)

```bash
cd packages/contracts
npm run bootstrap:liquidity:sepolia
npm run bootstrap:liquidity:bscTestnet
```

Major + registry-wide mUSD pair activation:

```bash
cd packages/contracts
npm run bootstrap:allpairs:sepolia
npm run bootstrap:allpairs:bscTestnet
```

Optional env knobs:

- `BOOTSTRAP_COLLATERAL_TOKEN`
- `BOOTSTRAP_MINT_COLLATERAL_AMOUNT`
- `BOOTSTRAP_LP_COLLATERAL_AMOUNT`
- `BOOTSTRAP_LP_MUSD_AMOUNT`
- `BOOTSTRAP_ENABLE_REGISTRY_TOKEN_POOLS=true`
- `BOOTSTRAP_REGISTRY_TOKEN_LIMIT=200`
- `BOOTSTRAP_EXTRA_TOKEN_ADDRESSES=0x...,0x...`

Note:

- Bootstrap requires collateral token balance in deployer wallet (USDC/USDT by default in testnet configs).
- If deployer has only native gas token, obtain collateral test tokens first (or override collateral token config intentionally).

## 9) Chain registry refresh

```bash
npm run registry:generate
```

Output:

- `packages/sdk/data/chain-registry.generated.json`
- Optional offline fallback seeds:
  - `packages/contracts/deploy/pair-seeds.bscTestnet.json`
  - `packages/contracts/deploy/pair-seeds.sepolia.json` (optional, create when needed)

Used by:

- API `/tokens`, `/risk/assumptions`
- indexers (`INDEXER_CHAIN_KEY`)
- web network/router registry

## 10) Pipeline verification

```bash
python3 scripts/e2e_pipeline_check.py --api-base http://localhost:8500
```

Full phase check:

```bash
npm run check:phase6
```

## 11) Admin handoff (timelock/multisig)

```bash
cd packages/contracts
NEW_ADMIN_ADDRESS=0xYourSafeOrTimelock \
ADDRESS_REGISTRY_PATH=./deploy/address-registry.sepolia.json \
npm run handoff:admin -- --network sepolia
```

Then new admin executes `acceptOwnership()` on:

- `HarmonyFactory`
- `HarmonyRouter`
- `ResonanceVault` (if deployed)

## 12) Manual browser flow (GUI automation unavailable)

If automated `open -a ...` fails with `kLSNoExecutableErr`, use manual steps:

1. Open Chrome manually.
2. Navigate to `http://localhost:3300/harmony`.
3. For classic exchange workstation, navigate to `http://localhost:3300/exchange`.
4. Connect wallet (MetaMask/WalletConnect).
5. Switch wallet network to target chain (31337 / 11155111 / 97).
6. Select token pair (`token -> mUSD`), request quote.
7. Review fee split and risk panel.
8. Sign approval and swap transactions in wallet.

## 13) Troubleshooting

- `no deployer signer found`: set `PRIVATE_KEY` in `packages/contracts/.env`.
- `insufficient funds for gas`: fund deployer native token on target chain.
- `column min_out does not exist`: run `docker compose down -v` and restart to reinitialize DB schemas.
- `/quote` returns 422 on testnets: deploy contracts + bootstrap liquidity + regenerate chain registry.

## 14) Stop and clean

```bash
docker compose down -v
```
