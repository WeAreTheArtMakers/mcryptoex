# THREAT MODEL

Date: 2026-02-19

## 1) Scope

In-scope components:

- EVM contracts in `packages/contracts`
- Tempo API in `apps/api`
- Indexer/validator/ledger-writer services in `services/*`
- Infra data plane (Redpanda, Postgres, ClickHouse, observability)

Out-of-scope (MVP):

- Native BTC/SOL settlement
- Centralized bridge operator internals
- End-user wallet endpoint security

## 2) Assets to protect

- User funds in AMM pools and collateral vault logic
- mUSD supply integrity and collateralization safety
- Immutable accounting correctness (double-entry ledger)
- Availability of quote/analytics and event ingestion systems

## 3) Trust boundaries

- Wallet -> contracts: user signs tx directly (non-custodial boundary)
- Contracts -> indexer: event-only ingestion, no write authority over user funds
- Indexer/validator/writer -> databases: data integrity and idempotent writes
- Cross-chain wrapped assets: trust delegated to bridge custodians / messaging protocol assumptions

## 4) Threats and mitigations

1. Smart contract reentrancy/state manipulation
- Mitigations:
  - `ReentrancyGuard` on stabilizer/router
  - pair-level lock in AMM pair
  - explicit pause and circuit-breakers

2. Oracle manipulation or stale oracle data
- Mitigations:
  - price sanity min/max per collateral
  - staleness threshold checks
  - emergency pause/circuit breaker behavior

3. Runaway mUSD minting / peg instability
- Mitigations:
  - max mint per block
  - minimum collateralization ratio requirement
  - emergency collateral threshold and breaker trip

4. Treasury conversion abuse / griefing
- Mitigations:
  - permissionless but bounded harvest flow (allowlist, max amount/call, slippage cap)
  - pausability on `ResonanceVault`
  - distribution recipient/bps controls with sum-to-10000 guard
  - explicit conversion/distribution event trail for post-incident accounting

5. Governance key compromise
- Mitigations:
  - two-step ownership for factory/router
  - role-separated AccessControl for stabilizer/token
  - timelock/multisig handoff script (`handoff-admin.ts`)

6. Event ingestion tampering / replay
- Mitigations:
  - validator schema and action allowlist
  - deterministic `tx_id` generation
  - immutable append-only ledger tables
  - outbox pattern and topic separation

7. Compliance abuse risk
- Mitigations:
  - optional geofencing/sanctions hooks are explicit and operator-toggled
  - no hidden bypass path in API route handlers

8. Wrapped asset bridge depeg / custody failure
- Mitigations:
  - explicit documentation of trust assumptions
  - surfaced risk warnings in UI/docs
  - no claim of native BTC/SOL settlement in MVP

## 5) Residual risks

- MEV and sandwich risk for AMM swaps on public mempools.
- Dependency risk in external wrappers/bridges.
- Operational risk if pause/governance keys are mismanaged.

## 6) Incident response skeleton

1. Detect:
- monitor anomalous mint volume, fee spikes, failed validation ratios, outlier gas costs.

2. Contain:
- pause router/factory/stabilizer where required.
- disable affected frontend actions and publish operator status.

3. Eradicate:
- patch contracts/services, rotate compromised credentials, re-index affected data windows.

4. Recover:
- unpause only after collateral and invariant checks pass.
- publish incident postmortem with exact block ranges and corrective actions.
