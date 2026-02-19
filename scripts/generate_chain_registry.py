#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEPLOY_DIR = REPO_ROOT / 'packages' / 'contracts' / 'deploy'
OUT_PATH = REPO_ROOT / 'packages' / 'sdk' / 'data' / 'chain-registry.generated.json'

SELECTOR_ALL_PAIRS_LENGTH = '0x574f2ba3'
SELECTOR_ALL_PAIRS = '0x1e3dd18b'
SELECTOR_TOKEN0 = '0x0dfe1681'
SELECTOR_TOKEN1 = '0xd21220a7'
SELECTOR_GET_RESERVES = '0x0902f1ac'
SELECTOR_DECIMALS = '0x313ce567'
SELECTOR_SYMBOL = '0x95d89b41'


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
        'default_rpc_url': 'https://ethereum-sepolia-rpc.publicnode.com',
        'confirmation_depth': 2
    },
    {
        'network': 'bscTestnet',
        'chain_key': 'bnb-testnet',
        'chain_id': 97,
        'name': 'BNB Chain Testnet',
        'rpc_env_key': 'BSC_TESTNET_RPC_URL',
        'default_rpc_url': 'https://bsc-testnet-rpc.publicnode.com',
        'confirmation_depth': 3
    }
]


def _is_evm_address(value: str) -> bool:
    return bool(re.fullmatch(r'0x[a-fA-F0-9]{40}', str(value).strip()))


def _chain_suffix(chain_key: str) -> str:
    return chain_key.upper().replace('-', '_')


def _env_chain_or_global(name: str, chain_key: str, default: str = '') -> str:
    chain_name = f'{name}_{_chain_suffix(chain_key)}'
    return os.getenv(chain_name, os.getenv(name, default))


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


def _trust_assumptions(chain_key: str, checked_at: str) -> list[dict]:
    native_provider = _env_chain_or_global(
        'MUSD_POLICY_PROVIDER',
        chain_key,
        'mCryptoEx governance + oracle section'
    )
    btc_provider = _env_chain_or_global('BRIDGE_PROVIDER_WBTC', chain_key, 'provider-not-declared')
    sol_provider = _env_chain_or_global('BRIDGE_PROVIDER_WSOL', chain_key, 'provider-not-declared')

    btc_attested = _env_chain_or_global('BRIDGE_LAST_ATTESTED_AT_WBTC', chain_key, '')
    sol_attested = _env_chain_or_global('BRIDGE_LAST_ATTESTED_AT_WSOL', chain_key, '')

    return [
        {
            'endpoint': 'native-musd-policy',
            'asset_symbol': 'mUSD',
            'category': 'native',
            'risk_level': 'medium',
            'bridge_provider': native_provider,
            'last_attested_at': None,
            'last_checked_at': checked_at,
            'statement': 'Depends on Stabilizer collateral policy, oracle integrity, and governance controls.'
        },
        {
            'endpoint': 'wrapped-btc-evm',
            'asset_symbol': 'wBTC',
            'category': 'wrapped',
            'risk_level': 'high',
            'bridge_provider': btc_provider,
            'last_attested_at': btc_attested or None,
            'last_checked_at': checked_at,
            'statement': 'Bridge/custodian solvency and redeemability are external trust dependencies.'
        },
        {
            'endpoint': 'wrapped-sol-evm',
            'asset_symbol': 'wSOL',
            'category': 'wrapped',
            'risk_level': 'high',
            'bridge_provider': sol_provider,
            'last_attested_at': sol_attested or None,
            'last_checked_at': checked_at,
            'statement': 'Wrapped SOL representation depends on bridge contract and message relayer security.'
        }
    ]


def _rpc_call(rpc_url: str, method: str, params: list[Any]) -> Any:
    payload = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url=rpc_url,
        data=body,
        method='POST',
        headers={'Content-Type': 'application/json'}
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            response_payload = json.loads(resp.read().decode('utf-8'))
    except urllib.error.URLError as exc:
        response_payload = _rpc_call_with_curl(rpc_url, payload, exc)

    if response_payload.get('error'):
        raise RuntimeError(str(response_payload['error']))
    return response_payload.get('result')


def _rpc_call_with_curl(rpc_url: str, payload: dict[str, Any], original_exc: Exception) -> dict[str, Any]:
    command = [
        'curl',
        '-sS',
        '--max-time',
        '12',
        '-H',
        'Content-Type: application/json',
        '-d',
        json.dumps(payload, separators=(',', ':')),
        rpc_url
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        raise RuntimeError(f'rpc call failed via urllib and curl: {original_exc}; curl={stderr}') from original_exc

    try:
        decoded = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        snippet = completed.stdout.strip()[:200]
        raise RuntimeError(
            f'rpc call returned invalid json via curl after urllib failure: {snippet}'
        ) from exc
    if not isinstance(decoded, dict):
        raise RuntimeError('rpc call returned non-object payload via curl')
    return decoded


def _eth_call(rpc_url: str, to: str, data: str) -> str:
    result = _rpc_call(
        rpc_url,
        'eth_call',
        [
            {
                'to': to,
                'data': data
            },
            'latest'
        ]
    )
    if not isinstance(result, str):
        raise RuntimeError('eth_call returned non-hex result')
    return result


def _decode_uint(hex_value: str) -> int:
    value = str(hex_value).strip()
    if not value.startswith('0x'):
        raise RuntimeError(f'invalid hex uint: {value}')
    return int(value, 16)


def _decode_address(hex_value: str) -> str:
    value = str(hex_value).strip().lower()
    if not value.startswith('0x'):
        raise RuntimeError(f'invalid hex address: {value}')
    body = value[2:].rjust(64, '0')
    return f"0x{body[-40:]}"


def _decode_symbol(hex_value: str) -> str:
    value = str(hex_value).strip()
    if not value.startswith('0x'):
        return 'UNKNOWN'
    raw = bytes.fromhex(value[2:])

    if len(raw) == 32:
        return raw.rstrip(b'\x00').decode('utf-8', errors='ignore') or 'UNKNOWN'

    if len(raw) >= 96:
        offset = int.from_bytes(raw[:32], byteorder='big')
        if offset + 64 <= len(raw):
            length = int.from_bytes(raw[offset:offset + 32], byteorder='big')
            start = offset + 32
            end = start + length
            if end <= len(raw):
                decoded = raw[start:end].decode('utf-8', errors='ignore').strip('\x00')
                if decoded:
                    return decoded

    return 'UNKNOWN'


def _call_decimals(rpc_url: str, token_address: str) -> int:
    try:
        result = _eth_call(rpc_url, token_address, SELECTOR_DECIMALS)
        decimals = _decode_uint(result)
        if decimals < 0 or decimals > 255:
            return 18
        return decimals
    except Exception:
        return 18


def _call_symbol(rpc_url: str, token_address: str) -> str:
    try:
        result = _eth_call(rpc_url, token_address, SELECTOR_SYMBOL)
        symbol = _decode_symbol(result)
        return symbol or f'TKN{token_address[-4:]}'
    except Exception:
        return f'TKN{token_address[-4:]}'


def _to_decimal_str(raw_amount: int, decimals: int) -> str:
    amount = Decimal(raw_amount) / (Decimal(10) ** max(decimals, 0))
    return format(amount, 'f')


def _pad_uint256(value: int) -> str:
    return f'{value:064x}'


def _discover_pairs(
    *,
    rpc_url: str,
    factory_address: str,
    chain_entry: dict[str, Any],
    checked_at: str
) -> tuple[list[str], list[dict], dict[str, Any]]:
    max_pairs = int(os.getenv('PAIR_DISCOVERY_MAX_PAIRS', '200'))
    health: dict[str, Any] = {
        'rpc_connected': False,
        'latest_block': None,
        'checked_at': checked_at
    }
    pair_addresses: list[str] = []
    pairs: list[dict] = []

    latest_block_hex = _rpc_call(rpc_url, 'eth_blockNumber', [])
    latest_block = _decode_uint(str(latest_block_hex))
    health['rpc_connected'] = True
    health['latest_block'] = latest_block

    if not _is_evm_address(factory_address):
        health['discovery_status'] = 'factory-not-configured'
        return pair_addresses, pairs, health

    all_pairs_length = _decode_uint(_eth_call(rpc_url, factory_address, SELECTOR_ALL_PAIRS_LENGTH))
    discover_count = min(all_pairs_length, max_pairs)

    token_book = chain_entry.get('tokens', [])
    if not isinstance(token_book, list):
        token_book = []

    token_by_address = {
        str(token['address']).lower(): token
        for token in token_book
        if isinstance(token, dict) and _is_evm_address(str(token.get('address', '')))
    }

    for index in range(discover_count):
        data = SELECTOR_ALL_PAIRS + _pad_uint256(index)
        pair_address = _decode_address(_eth_call(rpc_url, factory_address, data))
        if not _is_evm_address(pair_address):
            continue

        token0_address = _decode_address(_eth_call(rpc_url, pair_address, SELECTOR_TOKEN0))
        token1_address = _decode_address(_eth_call(rpc_url, pair_address, SELECTOR_TOKEN1))
        reserves_hex = _eth_call(rpc_url, pair_address, SELECTOR_GET_RESERVES)

        reserves_body = reserves_hex[2:].rjust(64 * 3, '0')
        reserve0_raw = int(reserves_body[0:64], 16)
        reserve1_raw = int(reserves_body[64:128], 16)
        reserve_timestamp = int(reserves_body[128:192], 16)

        token0_meta = token_by_address.get(token0_address.lower())
        if token0_meta is None:
            token0_meta = _token_entry(
                _call_symbol(rpc_url, token0_address),
                f'Discovered token {token0_address[-6:]}',
                _call_decimals(rpc_url, token0_address),
                token0_address,
                'pair-discovery'
            )
            token_book.append(token0_meta)
            token_by_address[token0_address.lower()] = token0_meta

        token1_meta = token_by_address.get(token1_address.lower())
        if token1_meta is None:
            token1_meta = _token_entry(
                _call_symbol(rpc_url, token1_address),
                f'Discovered token {token1_address[-6:]}',
                _call_decimals(rpc_url, token1_address),
                token1_address,
                'pair-discovery'
            )
            token_book.append(token1_meta)
            token_by_address[token1_address.lower()] = token1_meta

        decimals0 = int(token0_meta.get('decimals', 18))
        decimals1 = int(token1_meta.get('decimals', 18))

        pairs.append(
            {
                'pair_address': pair_address,
                'token0_address': token0_address,
                'token1_address': token1_address,
                'token0_symbol': token0_meta.get('symbol', token0_address),
                'token1_symbol': token1_meta.get('symbol', token1_address),
                'reserve0_raw': str(reserve0_raw),
                'reserve1_raw': str(reserve1_raw),
                'reserve0_decimal': _to_decimal_str(reserve0_raw, decimals0),
                'reserve1_decimal': _to_decimal_str(reserve1_raw, decimals1),
                'reserve_block_timestamp': reserve_timestamp,
                'checked_at': checked_at
            }
        )
        pair_addresses.append(pair_address)

    chain_entry['tokens'] = token_book
    health['discovery_status'] = 'ok'
    health['discovered_pairs'] = len(pair_addresses)
    health['factory_address'] = factory_address
    return pair_addresses, pairs, health


def build_registry() -> dict:
    deployed = _read_deployed_registries()
    generated_at = datetime.now(timezone.utc).isoformat()

    chains: list[dict] = []
    for spec in CHAIN_SPECS:
        deployed_entry = deployed.get(spec['network'], {})
        contracts = deployed_entry.get('contracts', {})
        if not isinstance(contracts, dict):
            contracts = {}

        stabilizer = str(contracts.get('stabilizer', '')).strip()
        chain_entry = {
            'chain_key': spec['chain_key'],
            'chain_id': spec['chain_id'],
            'name': spec['name'],
            'network': spec['network'],
            'rpc_env_key': spec['rpc_env_key'],
            'default_rpc_url': spec['default_rpc_url'],
            'amm': {
                'swap_fee_bps': int(os.getenv('SWAP_FEE_BPS', '30'))
            },
            'contracts': {
                'musd': contracts.get('musd', ''),
                'stabilizer': stabilizer,
                'oracle': contracts.get('oracle', ''),
                'harmony_factory': contracts.get('harmonyFactory', ''),
                'harmony_router': contracts.get('harmonyRouter', '')
            },
            'indexer': {
                'pair_addresses': [],
                'stabilizer_addresses': [stabilizer] if _is_evm_address(stabilizer) else [],
                'start_block': 'latest',
                'confirmation_depth': spec['confirmation_depth']
            },
            'pairs': [],
            'network_health': {
                'rpc_connected': False,
                'latest_block': None,
                'checked_at': generated_at,
                'discovery_status': 'not-started'
            },
            'tokens': _resolve_tokens(spec, contracts),
            'trust_assumptions': _trust_assumptions(spec['chain_key'], generated_at),
            'provenance': {
                'deployed_registry_file': f"address-registry.{spec['network']}.json"
                if deployed_entry else None
            }
        }

        rpc_url = os.getenv(spec['rpc_env_key'], '').strip() or spec['default_rpc_url']
        if rpc_url:
            try:
                pair_addresses, pairs, health = _discover_pairs(
                    rpc_url=rpc_url,
                    factory_address=str(contracts.get('harmonyFactory', '')).strip(),
                    chain_entry=chain_entry,
                    checked_at=generated_at
                )
                chain_entry['pairs'] = pairs
                chain_entry['indexer']['pair_addresses'] = pair_addresses
                chain_entry['network_health'] = health
            except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as exc:
                chain_entry['network_health'] = {
                    'rpc_connected': False,
                    'latest_block': None,
                    'checked_at': generated_at,
                    'discovery_status': f'error: {exc}'
                }
        else:
            chain_entry['network_health'] = {
                'rpc_connected': False,
                'latest_block': None,
                'checked_at': generated_at,
                'discovery_status': 'rpc-url-missing'
            }

        chains.append(chain_entry)

    return {
        'version': 2,
        'generated_at': generated_at,
        'source': 'packages/contracts/deploy/address-registry.*.json + live-rpc-pair-discovery',
        'chains': chains
    }


def main() -> None:
    registry = build_registry()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(registry, indent=2) + '\n', encoding='utf-8')
    print(f'generated {OUT_PATH}')


if __name__ == '__main__':
    main()
