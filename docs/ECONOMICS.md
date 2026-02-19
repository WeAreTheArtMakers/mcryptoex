# ECONOMICS

Date: 2026-02-19

## Fee model (Movement 2)

- Total swap fee: `0.30%` (`30 bps`)
- Split:
  - LPs: `0.25%` (`25 bps`)
  - Protocol Treasury: `0.05%` (`5 bps`)

Configured in `HarmonyFactory`:

- `swapFeeBps` max cap: `<= 1000` (10.00%)
- `protocolFeeBps` max cap: `<= 30` (0.30%)
- invariant: `protocolFeeBps <= swapFeeBps`

Relevant contracts:

- `packages/contracts/contracts/harmony/HarmonyFactory.sol`
- `packages/contracts/contracts/harmony/HarmonyPair.sol`

## Revenue flow (non-custodial)

1. User signs swap in wallet (Router).
2. Pair accrues protocol fee on-chain and transfers fee token to Treasury (`ResonanceVault`).
3. Anyone can call `harvestAndConvert(tokenIn -> mUSD)` with slippage guards.
4. Treasury distributes mUSD to configured buckets:
   - `opsBudget` (default 40%)
   - `liquidityIncentives` (default 40%)
   - `reserveOrBuyback` (default 20%)

Relevant contract:

- `packages/contracts/contracts/treasury/ResonanceVault.sol`

## Keeper incentive

- Permissionless conversion caller incentive is bounded by `MAX_HARVEST_INCENTIVE_BPS = 100` (1.00%).
- Default incentive is `10 bps` in mUSD.
- Guardrails:
  - token allowlist,
  - max slippage bps,
  - max amount per call,
  - pausability.

## mUSD policy and peg hardening

`Stabilizer` rules (collateralized mint/burn):

- min collateral ratio default: `11000 bps` (110%)
- emergency ratio default: `10300 bps` (103%)
- max mint per block limit
- oracle staleness + min/max price sanity
- per-collateral stable band for USDC/USDT deploy config default: `1.00 +/- 2.00%` (`200 bps`)

References:

- `packages/contracts/contracts/musd/Stabilizer.sol`
- `packages/contracts/scripts/deploy-testnets.ts`
- `packages/contracts/deploy/sepolia-config.json`
- `packages/contracts/deploy/bscTestnet-config.json`

## Governance hooks

- Fee updates: `setFeeParams`, `setSwapFeeBps`, `setProtocolFeeBps`
- Treasury address updates: `setTreasury`
- Treasury distribution updates: `setDistributionConfig`
- Ownership transfer: `Ownable2Step` (timelock/multisig compatible)

## Observability metrics

Pipeline emits and tracks:

- `PROTOCOL_FEE_ACCRUED`
- `FEE_TRANSFERRED_TO_TREASURY`
- `TREASURY_CONVERTED_TO_MUSD`
- `DISTRIBUTION_EXECUTED`

Analytics datasets:

- protocol revenue in mUSD (daily)
- fee breakdown by token/pool
- conversion slippage rollups
