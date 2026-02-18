#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEPLOY_DIR = REPO_ROOT / 'packages' / 'contracts' / 'deploy'
OUT_PATH = REPO_ROOT / 'packages' / 'sdk' / 'data' / 'chain-registry.generated.json'


CHAIN_SPECS = [
    {
        'network': 'hardhat',
        'chain_key': 'hardhat-local',
        'chain_id': 31337,
        'name': 'Hardhat Local',
        'rpc_env_key': 'INDEXER_HARDHAT_RPC_URL',
        'default_rpc_url': 'http://host.docker.internal:8545',
        'confirmation_depth': 0
    },
    {
        'network': 'sepolia',
        'chain_key': 'ethereum-sepolia',
        'chain_id': 11155111,
        'name': 'Ethereum Sepolia',
        'rpc_env_key': 'SEPOLIA_RPC_URL',
        'default_rpc_url': '',
        'confirmation_depth': 2
    },
    {
        'network': 'bscTestnet',
        'chain_key': 'bnb-testnet',
        'chain_id': 97,
        'name': 'BNB Chain Testnet',
        'rpc_env_key': 'BSC_TESTNET_RPC_URL',
        'default_rpc_url': '',
        'confirmation_depth': 3
    }
]


def _read_deployed_registries() -> dict[str, dict]:
    found: dict[str, dict] = {}
    for path in sorted(DEPLOY_DIR.glob('address-registry.*.json')):
        payload = json.loads(path.read_text(encoding='utf-8'))
        network = str(payload.get('network', '')).strip()
        if network:
            found[network] = payload
    return found


def _token_entry(symbol: str, name: str, decimals: int, address: str, source: str) -> dict:
    return {
        'symbol': symbol,
        'name': name,
        'address': address,
        'decimals': decimals,
        'source': source
    }


def _resolve_tokens(spec: dict, contracts: dict) -> list[dict]:
    musd = contracts.get('musd', 'unconfigured-musd')
    if spec['chain_key'] == 'hardhat-local':
        token_a = contracts.get('tokenA', 'local-weth')
        token_b = contracts.get('tokenB', 'local-wbtc')
        collateral = contracts.get('collateral', 'local-usdc')
        return [
            _token_entry('mUSD', 'Musical USD', 18, musd, 'contracts.musd'),
            _token_entry('USDC', 'USD Coin (local collateral)', 6, collateral, 'contracts.collateral'),
            _token_entry('WETH', 'Wrapped Ether', 18, token_a, 'contracts.tokenA'),
            _token_entry('WBTC', 'Wrapped Bitcoin', 8, token_b, 'contracts.tokenB'),
            _token_entry('WSOL', 'Wrapped SOL (EVM)', 18, 'local-wsol', 'defaults')
        ]

    if spec['chain_key'] == 'ethereum-sepolia':
        return [
            _token_entry('mUSD', 'Musical USD', 18, musd, 'contracts.musd'),
            _token_entry('WETH', 'Wrapped Ether', 18, 'bridge-weth-sepolia', 'defaults'),
            _token_entry('wBTC', 'Wrapped Bitcoin (bridge)', 8, 'bridge-wbtc-sepolia', 'defaults'),
            _token_entry('wSOL', 'Wrapped SOL (bridge)', 18, 'bridge-wsol-sepolia', 'defaults')
        ]

    return [
        _token_entry('mUSD', 'Musical USD', 18, musd, 'contracts.musd'),
        _token_entry('WBNB', 'Wrapped BNB', 18, 'bridge-wbnb-bsc', 'defaults'),
        _token_entry('wBTC', 'Wrapped Bitcoin (bridge)', 18, 'bridge-wbtc-bsc', 'defaults'),
        _token_entry('wSOL', 'Wrapped SOL (bridge)', 18, 'bridge-wsol-bsc', 'defaults')
    ]


def _trust_assumptions() -> list[dict]:
    return [
        {
            'endpoint': 'native-musd-policy',
            'asset_symbol': 'mUSD',
            'category': 'native',
            'risk_level': 'medium',
            'statement': 'Depends on Stabilizer collateral policy, oracle integrity, and governance controls.'
        },
        {
            'endpoint': 'wrapped-btc-evm',
            'asset_symbol': 'wBTC',
            'category': 'wrapped',
            'risk_level': 'high',
            'statement': 'Bridge/custodian solvency and redeemability are external trust dependencies.'
        },
        {
            'endpoint': 'wrapped-sol-evm',
            'asset_symbol': 'wSOL',
            'category': 'wrapped',
            'risk_level': 'high',
            'statement': 'Wrapped SOL representation depends on bridge contract and message relayer security.'
        }
    ]


def build_registry() -> dict:
    deployed = _read_deployed_registries()

    chains: list[dict] = []
    for spec in CHAIN_SPECS:
        deployed_entry = deployed.get(spec['network'], {})
        contracts = deployed_entry.get('contracts', {})
        if not isinstance(contracts, dict):
            contracts = {}

        stabilizer = contracts.get('stabilizer', '')
        pair_addresses = deployed_entry.get('pairs', [])
        if not isinstance(pair_addresses, list):
            pair_addresses = []

        chain_entry = {
            'chain_key': spec['chain_key'],
            'chain_id': spec['chain_id'],
            'name': spec['name'],
            'network': spec['network'],
            'rpc_env_key': spec['rpc_env_key'],
            'default_rpc_url': spec['default_rpc_url'],
            'contracts': {
                'musd': contracts.get('musd', ''),
                'stabilizer': stabilizer,
                'oracle': contracts.get('oracle', ''),
                'harmony_factory': contracts.get('harmonyFactory', ''),
                'harmony_router': contracts.get('harmonyRouter', '')
            },
            'indexer': {
                'pair_addresses': pair_addresses,
                'stabilizer_addresses': [stabilizer] if stabilizer else [],
                'start_block': 'latest',
                'confirmation_depth': spec['confirmation_depth']
            },
            'tokens': _resolve_tokens(spec, contracts),
            'trust_assumptions': _trust_assumptions(),
            'provenance': {
                'deployed_registry_file': f"address-registry.{spec['network']}.json"
                if deployed_entry else None
            }
        }

        chains.append(chain_entry)

    return {
        'version': 1,
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'source': 'packages/contracts/deploy/address-registry.*.json',
        'chains': chains
    }


def main() -> None:
    registry = build_registry()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(registry, indent=2) + '\n', encoding='utf-8')
    print(f'generated {OUT_PATH}')


if __name__ == '__main__':
    main()
