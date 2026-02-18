# @mcryptoex/sdk

Movement 6 SDK boundary package for:

- chain adapter interfaces (`src/adapters/*`)
- chain-registry TypeScript types (`src/chain-registry/types.ts`)
- generated chain registry data source:
  - `data/chain-registry.generated.json`

Generate/update registry from deployment outputs:

```bash
python3 scripts/generate_chain_registry.py
```
