# TRUST ASSUMPTIONS

Date: 2026-02-19

## Non-custodial boundary

- mCryptoEx does not custody user private keys.
- Trade execution is wallet-signed directly against on-chain Router/Pair contracts.
- Tempo API/indexer/ledger services are read/analytics infrastructure and cannot authorize swaps.

## mUSD assumptions

mUSD safety depends on:

- collateral reserve adequacy,
- oracle correctness/freshness,
- governance key management (roles/ownership),
- pause/circuit-breaker responsiveness.

Primary references:

- `packages/contracts/contracts/musd/Stabilizer.sol`
- `packages/contracts/contracts/musd/MUSDToken.sol`

## Testnet collateral assumptions

Current testnet collateral mappings in deploy config:

- Sepolia USDC: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- Sepolia tUSDT: `0x01a6810727db185bbf7f30ec158c3ac8b8112627`
- BSC testnet USDC: `0x64544969ed7EBf5f083679233325356EbE738930`
- BSC testnet USDT: `0x66E972502A34A625828C544a1914E8D8cc2A9dE5`

Important:

- `tUSDT` on Sepolia is a test token representation (not a claim of native mainnet USDT settlement).
- BSC testnet addresses are test assets; liquidity/redeemability guarantees are environment-dependent.

## Wrapped asset assumptions (wBTC/wSOL)

MVP supports wrapped-asset boundaries on EVM only.

Risk dependencies:

- bridge contract security,
- bridge operator/custodian solvency,
- attestation and messaging correctness,
- redemption availability under stress.

## Cross-chain scope

- Implemented: EVM-first (Hardhat, Sepolia, BSC testnet)
- Not implemented in MVP: native BTC/SOL settlement

Any UI/backend reference to BTC/SOL in MVP is as wrapped-asset abstraction only.

## Operator assumptions

- RPC availability and integrity for indexing/quotes.
- Correct `.env` handling for private keys (local only; never committed).
- Governance ownership handoff to multisig/timelock before production operation.

## User-facing risk surfacing

Risk assumptions are exposed through:

- API endpoint: `/risk/assumptions`
- UI panel: `/harmony` Dissonance Guards section

Metadata includes bridge provider and attestation/check timestamps where configured.
