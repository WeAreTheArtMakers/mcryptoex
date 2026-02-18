# Phase 4 Run Check

## Objective

Validate Orchestra UI Movement 4 baseline:

1. `/overture` wallet-first landing
2. `/harmony` swap quote integration with Tempo API (`/quote`)
3. wallet connect buttons (injected + optional WalletConnect)
4. network mismatch prompt (`useSwitchChain`)

## Workspace build check

```bash
cd apps/web
npm install
npm run build
```

Expected:

- Next.js build completes
- route list includes `/harmony` and `/overture`

## Full stack run

```bash
cp .env.example .env
docker compose up --build
```

Open:

- `http://localhost:3300/overture`
- `http://localhost:3300/harmony`

Expected container mapping:

- `web` -> `0.0.0.0:3300->3000/tcp`

Quick verify:

```bash
docker compose ps web
docker compose logs --tail=40 web
```

## Optional env vars

- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` for WalletConnect QR flow
- `NEXT_PUBLIC_LOCAL_RPC_URL` for local hardhat RPC hint

## BuildKit metadata stall fallback

If Docker BuildKit stalls on `node:20-alpine` metadata, retry with classic builder:

```bash
DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose up --build
```

## Quick UI checks

1. In read-only mode, request quote on `/harmony`.
2. Connect injected wallet and verify address appears.
3. Change quote chain and verify network-switch prompt appears when chain differs.
