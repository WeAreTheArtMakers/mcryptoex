# Slither Triage: Noise vs Actionable

Date: 2026-02-19

## Run context

Command used:

```bash
docker run --rm \
  -v "$PWD/packages/contracts:/work" \
  -w /work \
  ghcr.io/crytic/slither:latest \
  slither . --compile-force-framework hardhat --exclude naming-convention,solc-version
```

Latest raw output log: `/tmp/mcryptoex-slither-latest.log`

Observed summary: `131 result(s)` across `87 contracts` (reconfirmed in `npm run check:phase6` on 2026-02-19).

## Tooling caveat (important)

- The stock Slither image does not include `npx`, so Hardhat config probing fails (`Cannot execute npx`).
- Slither still runs, but fallback compilation increases duplicate findings and can report stale line ranges.
- This affects confidence for findings like `unchecked-transfer` and repeated `unused-return`.

Action item:

- Build/use a pinned Slither image with Node.js + `npx` for deterministic Hardhat-aware scans before audit freeze.

## Actionable findings

1. `reentrancy-no-eth` on DEX/stabilizer hot paths

- Surfaces on `HarmonyFactory.createPair`, `HarmonyPair.swap`, `Stabilizer.mintWithCollateral`, `Stabilizer.burnForCollateral`.
- Current mitigations:
  - `Stabilizer` uses `nonReentrant` and circuit-breaker checks.
  - `HarmonyPair` uses the `lock` mutex pattern.
  - `HarmonyFactory` pair init is restricted by pair-side `factory` check.
- Required follow-up:
  - Keep high-priority invariant tests around reserve conservation, pause semantics, and mint/burn accounting.
  - Re-validate with Hardhat-aware Slither image and treat any surviving non-benign item as P1.

2. `low-level-calls` in token transfer helpers

- Found in `contracts/harmony/HarmonyPair.sol` and `contracts/harmony/libraries/TransferHelper.sol`.
- Current state: intentional compatibility pattern for non-standard ERC20s, with success/return-data checks.
- Required follow-up:
  - Keep explicit tests for non-standard token return behaviors in pre-audit test suite.
  - Do not remove return-value checks around LP token transfer paths.

## Noise / accepted-by-design findings

1. OpenZeppelin dependency internals:

- `incorrect-exp`, `divide-before-multiply`, `assembly`, `shadowing-local`, `pragma`, `too-many-digits`, `unindexed-event-address`.
- Classified as dependency noise (library code, not custom protocol logic).

2. Uniswap-v2 style mechanics:

- `weak-prng` (`block.timestamp % 2**32`) reserve timestamp storage pattern.
- `calls-loop` in router `_swap` multi-hop execution.
- `incorrect-equality` for strict invariant checks in AMM math.
- Classified as expected design patterns; tracked as informational.

3. High-noise generic detectors:

- `timestamp` triggers on many non-time-risk comparisons.
- `unused-return` on tuple destructuring patterns and factory create call side effects.
- `unchecked-transfer` currently appears despite explicit LP `transferFrom` return checking in router, likely due fallback compile context.

## Triage policy

- `Actionable`: requires code/test change or explicit audit sign-off before mainnet.
- `Noise`: documented rationale + monitored at each release branch cut.
- Re-run Slither on every release candidate and update this file with delta findings.
