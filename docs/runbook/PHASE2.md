# Phase 2 Run Check

## Contract workspace setup

```bash
cd packages/contracts
cp .env.example .env
npm install
npm run compile
```

## Execute tests

```bash
npm test
```

Expected:
- mUSD/Stabilizer tests pass
- Harmony Engine swap/liquidity tests pass
- local performance test logs swap gas and passes

## Local deployment registry

```bash
npm run deploy:local
```

Produces:
- `packages/contracts/deploy/address-registry.hardhat.json`

(Note: registry output is intentionally git-ignored.)
