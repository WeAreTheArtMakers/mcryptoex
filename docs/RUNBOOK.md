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

Verify + publish (explorer source verification):

```bash
npm run verify:publish:sepolia
npm run verify:publish:bscTestnet
```

Optional flags:

- `VERIFY_INCLUDE_PAIRS=true|false` (default `true`)
- `VERIFY_INCLUDE_COLLATERALS=true|false` (default `true`)
- `VERIFY_EXTRA_PAIR_ADDRESSES=0x...,0x...`
- `VERIFY_REGISTRY_PATH=packages/contracts/deploy/address-registry.<network>.json`

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

MODX market bootstrap on BSC testnet (`mUSD/MODX`):

```bash
npm run bootstrap:modx:bscTestnet
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

- Bootstrap first tries direct `mUSD` mint if deployer has `MINTER_ROLE`.
- If direct mint is unavailable, bootstrap falls back to collateral mint path (USDC/USDT by default).
- If deployer has only native gas token and no minter role, collateral test tokens are still required.

## 8.1) Single-command BSC + Sepolia bootstrap + OHLC seed

From repository root:

```bash
npm run bootstrap:musd:testnets
```

This command runs:

1. `deploy` on BSC testnet
2. `bootstrap:allpairs` on BSC testnet
3. `seed:ohlc` on BSC testnet (real wallet-signed swaps)
4. `deploy` on Sepolia
5. `bootstrap:allpairs` on Sepolia
6. `seed:ohlc` on Sepolia (real wallet-signed swaps)
7. `registry:generate`

If you need only OHLC seeding:

```bash
npm run seed:ohlc:bsc
npm run seed:ohlc:sepolia
```

These wrappers now resolve a reachable RPC endpoint before running Hardhat.
Resolver probe command (manual check):

```bash
bash scripts/resolve-rpc-url.sh bscTestnet
bash scripts/resolve-rpc-url.sh sepolia
```

Continuous market-maker style trade generation (local operator loop):

```bash
npm run bot:market:bsc
# or
npm run bot:market:sepolia
```

Detached/persistent BSC loop (Docker-managed):

```bash
npm run bot:loop:bsc:start
npm run bot:loop:bsc:logs
# stop
npm run bot:loop:bsc:stop
```

Create a dedicated seed/bot wallet and fund it with native gas + mUSD (local-only secret files):

```bash
npm run bot:wallet:new:bsc
# or
npm run bot:wallet:new:sepolia
```

Generated secret files:

- `.local-secrets/seed-bot-wallets.json`
- `.local-secrets/bot-<label>-<network>.env`

Bot env knobs:

- `BOT_SYMBOLS=WBNB,USDC,USDT,MODX`
- `BOT_INTERVAL_SEC=45`
- `BOT_ROUNDS=1`
- `BOT_SLIPPAGE_BPS=90`
- `BOT_REVERSE_MUSD_AMOUNT=12`
- `BOT_PRIVATE_KEY=0x...` (optional dedicated bot signer instead of default `PRIVATE_KEY`)
- `BOT_GAS_GUARD_MIN_NATIVE=0.05`
- `BOT_GAS_GUARD_MODE=stop|warn` (default `stop`; `stop` halts cycle before any trade when native gas is low)

Optional env knobs for `seed:ohlc`:

- `OHLC_SEED_SYMBOLS=WBNB,USDC,USDT,WBTC,WETH,WSOL,WAVAX`
- `OHLC_SEED_ROUNDS=2`
- `OHLC_SEED_SLIPPAGE_BPS=500`
- `OHLC_SEED_INCLUDE_REVERSE=true`
- `OHLC_SEED_REVERSE_MUSD_AMOUNT=4`
- `OHLC_SEED_STRICT=false`
- `OHLC_SEED_ACQUIRE_WITH_MUSD=true` (if token balance is missing, buys token via `mUSD -> token` before seed swap)
- `OHLC_SEED_ACQUIRE_BUFFER_BPS=500`

Peg stabilizer bot (USDC/USDT/mUSD parity maintenance):

```bash
# one-shot correction cycle
npm run peg:once:bsc

# continuous loop
npm run peg:bot:bsc
```

Peg bot env knobs:

- `PEG_BOT_SYMBOLS=USDC,USDT`
- `PEG_BOT_INTERVAL_SEC=35`
- `PEG_BOT_PRIVATE_KEY=0x...` (optional dedicated peg signer)
- `PEG_BOT_GAS_GUARD_MIN_NATIVE=0.03`
- `PEG_BOT_GAS_GUARD_MODE=stop|warn`
- `PEG_BOT_KILL_SWITCH_FILE=.peg-bot-kill-switch` (create with `echo 1 > .peg-bot-kill-switch` to hard-stop)

Peg correction controls (`packages/contracts/scripts/stabilize-peg.ts`):

- `PEG_TRIGGER_BPS=80`
- `PEG_TARGET_PRICE=1`
- `PEG_CORRECTION_FRACTION_BPS=4000`
- `PEG_MAX_ACTION_MUSD=600`
- `PEG_MIN_ACTION_MUSD=5`
- `PEG_SLIPPAGE_BPS=120`
- `PEG_ALLOW_MINT=true`
- `PEG_ALLOW_BURN=true`
- `PEG_DRY_RUN=true|false`

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
