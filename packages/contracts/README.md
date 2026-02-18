# packages/contracts

Hardhat workspace for Movement 2:

- mUSD contracts (`MUSDToken`, `Stabilizer`)
- Harmony Engine AMM (`HarmonyFactory`, `HarmonyPair`, `HarmonyRouter`)
- Mocks and deploy scripts
- Contract tests including local swap performance check

## Commands

```bash
cd packages/contracts
cp .env.example .env
npm install
npm run compile
npm test
npm run test:performance
```
