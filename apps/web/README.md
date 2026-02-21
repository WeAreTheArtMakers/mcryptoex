# apps/web

Orchestra UI (Next.js + Tailwind + wagmi).

## Phase 4 focus

- `/overture`: wallet-first landing
- `/harmony`: swap quote flow (`/quote`) + wallet connect
- network mismatch prompts (`useSwitchChain`)
- read-only mode works without wallet

## Local run (workspace)

```bash
cd apps/web
npm install
npm run dev
```

## mUSD Quote Venue (Pro Terminal)

The `/pro` terminal is configured as an `mUSD`-quoted venue:

- spot markets are generated as `BASE/mUSD`
- multi-hop routing defaults through `mUSD` when input/output are both non-`mUSD`
- execution remains wallet-signed and non-custodial

### Token registry source of truth

Use `/Users/bg/Desktop/mUSD-Exchange/mcryptoex/apps/web/app/pro/tokens.config.ts`:

- `TOKEN_PRESETS` defines symbol metadata, wrapped flags, aliases, risk flags
- `NEXT_PUBLIC_EXTRA_MARKET_BASES` appends extra market base symbols
- `NEXT_PUBLIC_DEFAULT_MARKET` sets initial pair (example: `MUSD/WETH`)

To add a new token to the market universe:

1. Add/update a preset in `TOKEN_PRESETS`.
2. Ensure token is present in chain `/tokens` response (address + decimals).
3. Add symbol to `NEXT_PUBLIC_EXTRA_MARKET_BASES` if it is not in default base list.

### Market generation

Market rows are generated in:

- `/Users/bg/Desktop/mUSD-Exchange/mcryptoex/apps/web/app/pro/markets.config.ts`

`buildVenueMarkets(...)` creates rows as `{ baseToken, quoteToken: mUSD }` using:

- token registry (`buildTokenRegistry`)
- on-chain pairs (`/pairs`)
- pair stats (`/ledger/recent` derived)

If pool is missing/thin, market is still listed with warnings and low-liquidity flags.

### mUSD route enforcement

Route planning is in:

- `/Users/bg/Desktop/mUSD-Exchange/mcryptoex/apps/web/app/pro/route-builder.ts`

`buildRoutePlan(...)` behavior:

- direct route if one side is `mUSD`
- forced route `tokenIn -> mUSD -> tokenOut` when `REQUIRE_MUSD_QUOTE=true`
- returns combined fee/slippage + user note shown in order entry

### Feature flags

Set these environment variables for the web app:

- `NEXT_PUBLIC_REQUIRE_MUSD_QUOTE=true|false`
- `NEXT_PUBLIC_ENABLE_ADMIN_MINT_UI=true|false`
- `NEXT_PUBLIC_DEFAULT_MARKET=MUSD/WBNB` (or another pair)
- `NEXT_PUBLIC_EXTRA_MARKET_BASES=TOKEN1,TOKEN2`
- `NEXT_PUBLIC_ADMIN_MINT_ALLOWLIST=0x...,0x...`

### Admin mint panel (optional)

When enabled (`NEXT_PUBLIC_ENABLE_ADMIN_MINT_UI=true`) and wallet is allowlisted:

- admin panel appears in `/pro` order entry
- checks `MINTER_ROLE` on mUSD contract
- executes `mint(to, amount)` via connected wallet
- shows recent mint events from on-chain `Transfer(from=0x0)` logs
