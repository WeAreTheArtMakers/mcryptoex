# packages/contracts

Hardhat workspace for Movement 2:

- mUSD contracts (`MUSDToken`, `Stabilizer`)
- Harmony Engine AMM (`HarmonyFactory`, `HarmonyPair`, `HarmonyRouter`)
- Mocks and deploy scripts
- Contract tests including local swap performance check
- Testnet deploy with multi-collateral support (USDC/USDT) and peg guard bands

## Commands

```bash
cd packages/contracts
cp .env.example .env
npm install
npm run compile
npm test
npm run test:performance
```

## Testnet deploy (Sepolia / BNB testnet)

1. Create `packages/contracts/.env` from `.env.example`.
2. Set required values:
   - `PRIVATE_KEY`
   - `SEPOLIA_RPC_URL`
   - `BSC_TESTNET_RPC_URL`
3. Set collateral addresses (recommended):
   - `USDC_TOKEN_ADDRESS`
   - `USDT_TOKEN_ADDRESS`
   - `STABLE_COLLATERAL_MAX_DEVIATION_BPS=200` (default, enforces 1.00 +/- 2.00%)

Deploy:

```bash
cd packages/contracts
npm run deploy:sepolia
npm run deploy:bscTestnet
```

Bootstrap first mUSD/stable pool liquidity (after deploy):

```bash
# optional amounts:
# BOOTSTRAP_MINT_COLLATERAL_AMOUNT=100
# BOOTSTRAP_LP_COLLATERAL_AMOUNT=50
# BOOTSTRAP_LP_MUSD_AMOUNT=50
npm run bootstrap:liquidity:sepolia
npm run bootstrap:liquidity:bscTestnet
```

This script mints mUSD via `Stabilizer` and adds first `mUSD <-> collateral` liquidity so `/quote` can return real on-chain routes.

Deployment writes:

- `packages/contracts/deploy/address-registry.sepolia.json`
- `packages/contracts/deploy/address-registry.bscTestnet.json`

Then refresh chain registry for API/UI/indexer:

```bash
cd /Users/bg/Desktop/mUSD-Exchange/mcryptoex
python3 scripts/generate_chain_registry.py
docker compose up --build -d api indexer-ethereum indexer-bnb web
```
