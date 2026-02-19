# SECURITY

Date: 2026-02-19

## Security posture

mCryptoEx is designed as a non-custodial exchange platform:

- The platform never holds user private keys.
- Swaps and liquidity actions are wallet-signed on-chain transactions.
- API/indexer services are read/quote/analytics infrastructure and are not trade authorizers.

## Smart contract controls (Phase 5)

Implemented controls:

- `MUSDToken`:
  - role-gated minting (`MINTER_ROLE`)
  - pausability on mint and transfers
  - EIP-2612 permit support
- `Stabilizer`:
  - `Pausable` and `ReentrancyGuard`
  - max mint per block (`maxMintPerBlock`)
  - oracle freshness guard (`oracleStalenessThreshold`)
  - oracle price sanity bands per collateral
  - collateral ratio thresholds with emergency circuit breaker
  - separated roles (`GOVERNOR_ROLE`, `OPERATOR_ROLE`, `PAUSER_ROLE`)
- `HarmonyFactory`:
  - owner-controlled fee updates with max cap
  - protocol fee cap + treasury address control
  - pausability on pair creation
  - two-step ownership (timelock/multisig compatible)
- `HarmonyPair`:
  - reentrancy lock (`lock` modifier)
  - factory pause awareness (`EnginePaused` guard on mint/burn/swap)
  - permanent LP minimum-liquidity lock to dead address
  - explicit protocol fee accrual event (`ProtocolFeeAccrued`)
- `HarmonyRouter`:
  - `Pausable` + `ReentrancyGuard`
  - owner-controlled path-length cap (`maxPathLength`)
  - slippage and deadline controls
  - two-step ownership (timelock/multisig compatible)
- `ResonanceVault`:
  - permissionless harvest/convert with bounded incentive
  - token allowlist and per-call amount guardrails
  - max slippage controls for conversion calls
  - pausability + ownership handoff (`Ownable2Step`)
  - explicit fee/conversion/distribution events for ledger pipeline

## Backend and pipeline controls

- Structured immutable ledger writes (`dex_ledger_entries`) with idempotent note insert path.
- Validator allows only explicit DEX actions.
- Correlation IDs are preserved across Note topics.
- Treasury lifecycle actions are indexed:
  - `PROTOCOL_FEE_ACCRUED`
  - `FEE_TRANSFERRED_TO_TREASURY`
  - `TREASURY_CONVERTED_TO_MUSD`
  - `DISTRIBUTION_EXECUTED`
- Optional compliance hooks (operator enabled):
  - geofencing country block list
  - sanctions blocked wallet list
  - configured through API env vars:
    - `COMPLIANCE_ENFORCEMENT_ENABLED`
    - `COMPLIANCE_BLOCKED_COUNTRIES`
    - `COMPLIANCE_SANCTIONS_BLOCKED_WALLETS`

## Key operational controls

- No secrets in source control.
- `.local-secrets/` reserved for local private materials and gitignored.
- `.env.example` only contains non-secret placeholders.
- Address registries are versioned without private keys.

## Static checks and tests

- Contract tests (Hardhat): pause flows, path guardrails, mint/burn and circuit breakers, swap performance check.
- Web production build checks.
- Pipeline e2e smoke check (`scripts/e2e_pipeline_check.py`).
- Security check wrapper (`scripts/security_check.sh`):
  - contract compile + tests
  - Python syntax compile
  - tracked-secrets guard
  - Slither run (local binary if available, otherwise dockerized Slither)
- Slither triage ledger:
  - `docs/security/SLITHER_TRIAGE.md` (noise vs actionable classification with follow-ups)

## Audit readiness checklist

- [x] Deterministic deployment scripts and address registries
- [x] Event coverage for major accounting actions
- [x] Role separation for mUSD policy controls
- [x] Pause/circuit-breaker procedures documented
- [x] Timelock/multisig handoff script
- [ ] Independent third-party audit report (Future Movement)
- [ ] Formal verification of invariant-critical math (Future Movement)

## Responsible disclosure

Until a public security contact is published, open a private advisory through repository security advisories and include:

- chain/network
- transaction hash(es)
- affected contracts and function selectors
- reproduction steps and impact
