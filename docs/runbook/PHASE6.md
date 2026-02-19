# Phase 6 Run Check

## Objective

Validate cross-chain adapter boundaries and chain-aware indexing baseline:

1. chain registry is generated from deployment artifacts
2. indexer workers run per chain key (`hardhat-local`, `ethereum-sepolia`, `bnb-testnet`)
3. Tempo API serves `/tokens` and `/risk/assumptions` from registry
4. `/harmony` chain selector and risk panel use registry-backed API responses
5. non-local `/quote` requires real on-chain liquidity routes (no mock fallback)

## Deploy real testnet contracts (required for live swap)

To activate real token->mUSD swap on Sepolia/BNB testnet, deploy and persist:

- `mUSD`
- `Stabilizer`
- `HarmonyFactory`
- `HarmonyRouter`

Commands:

```bash
cd packages/contracts
cp .env.example .env
# set PRIVATE_KEY + RPC URLs + USDC/USDT token addresses
npm run deploy:sepolia
npm run deploy:bscTestnet
```

Outputs:

- `packages/contracts/deploy/address-registry.sepolia.json`
- `packages/contracts/deploy/address-registry.bscTestnet.json`

`deploy-testnets.ts` configures USDC/USDT collateral with 1.00 +/- 2.00% oracle band by default.

## Bootstrap first pool liquidity (required for `/quote` on testnets)

After deploy, initialize at least one `mUSD` pair (e.g. `mUSD/USDC`):

```bash
cd packages/contracts
npm run bootstrap:liquidity:sepolia
npm run bootstrap:liquidity:bscTestnet
```

Without liquidity, testnet `/quote` intentionally returns `404 no on-chain liquidity route`.

## Generate registry

```bash
python3 scripts/generate_chain_registry.py
```

## Compose bring-up

```bash
cp .env.example .env
docker compose up --build
```

Expected indexer services:

- `indexer-local`
- `indexer-ethereum`
- `indexer-bnb`

## Endpoint checks

```bash
curl -sS "http://localhost:8500/tokens"
curl -sS "http://localhost:8500/risk/assumptions?chain_id=97"
curl -sS "http://localhost:8500/quote?chain_id=11155111&token_in=WETH&token_out=mUSD&amount_in=1&slippage_bps=50"
```

## Full check bundle

```bash
npm run check:phase6
```
