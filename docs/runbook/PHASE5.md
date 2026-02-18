# Phase 5 Run Check

## Objective

Validate hardening for:

1. mUSD controls (pause, oracle sanity/staleness, per-block mint guard, circuit breaker)
2. Harmony Engine controls (factory/router pause, route-length guardrails, owner-only controls)
3. Security docs and runbook completeness
4. Pipeline and UI regression safety

## Contract tests

```bash
cd packages/contracts
npm install
npm test
```

Expected:

- Hardhat tests pass (including pause/path guardrail tests)
- `performance.local-swap.test.ts` logs gas profile

## Full stack regression checks

From repo root:

```bash
npm run web:build
python3 scripts/e2e_pipeline_check.py
./scripts/security_check.sh
```

Expected:

- web build succeeds with Next.js 14.2.35+
- e2e pipeline check returns `status: ok`
- security bundle passes local checks

## Docs presence check

```bash
test -f docs/ARCHITECTURE.md
test -f docs/RUNBOOK.md
test -f docs/SECURITY.md
test -f docs/THREAT_MODEL.md
test -f docs/MUSICAL_GLOSSARY.md
```
