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
ENV_CANDIDATES = [REPO_ROOT / '.env', REPO_ROOT / 'packages' / 'contracts' / '.env']

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

CANONICAL_WRAPPED_BY_CHAIN: dict[str, list[dict[str, Any]]] = {
    'ethereum-sepolia': [
        {
            'symbol': 'WETH',
            'name': 'Wrapped Ether',
            'address': '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
            'decimals': 18
        }
    ],
    'bnb-testnet': [
        {
            'symbol': 'WBNB',
            'name': 'Wrapped BNB',
            'address': '0xae13d989dac2f0debff460ac112a837c89baa7cd',
            'decimals': 18
        }
    ]
}

STATIC_CHAIN_TOKENS: dict[str, list[dict[str, Any]]] = {
    'bnb-testnet': [
        {
            'symbol': 'MODX',
            'name': 'modX Token',
            'address': '0xB6322eD8561604Ca2A1b9c17e4d02B957EB242fe',
            'decimals': 18
        }
    ]
}


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return

    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except OSError:
        return

    for raw in lines:
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        if not key:
            continue
        cleaned = value.strip().strip("'").strip('"')
        if not cleaned:
            continue

        current = os.environ.get(key, '').strip()
        if current:
            key_upper = key.upper()
            if key_upper in {'SEPOLIA_RPC_URL', 'BSC_TESTNET_RPC_URL', 'INDEXER_HARDHAT_RPC_URL'}:
                if 'publicnode.com' not in current.lower():
                    continue
            else:
                continue

        os.environ[key] = cleaned


def _load_known_env_files() -> None:
    for path in ENV_CANDIDATES:
        _load_env_file(path)


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


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


def _read_previous_generated_registry() -> dict[str, dict]:
    if not OUT_PATH.exists():
        return {}
    try:
        payload = json.loads(OUT_PATH.read_text(encoding='utf-8'))
    except json.JSONDecodeError:
        return {}
    chains = payload.get('chains')
    if not isinstance(chains, list):
        return {}

    previous: dict[str, dict] = {}
    for chain in chains:
        if not isinstance(chain, dict):
            continue
        chain_key = str(chain.get('chain_key', '')).strip()
        if not chain_key:
            continue
        previous[chain_key] = chain
    return previous


def _read_pair_seed(network: str) -> dict[str, Any]:
    seed_path = DEPLOY_DIR / f'pair-seeds.{network}.json'
    if not seed_path.exists():
        return {}
    try:
        payload = json.loads(seed_path.read_text(encoding='utf-8'))
    except json.JSONDecodeError:
        return {}
    if not isinstance(payload, dict):
        return {}

    raw_tokens = payload.get('tokens') if isinstance(payload.get('tokens'), list) else []
    raw_pairs = payload.get('pairs') if isinstance(payload.get('pairs'), list) else []

    tokens: list[dict] = []
    for token in raw_tokens:
        if not isinstance(token, dict):
            continue
        address = str(token.get('address', '')).strip()
        if not _is_evm_address(address):
            continue
        tokens.append(token)

    pairs: list[dict] = []
    for pair in raw_pairs:
        if not isinstance(pair, dict):
            continue
        pair_address = str(pair.get('pair_address', '')).strip()
        token0_address = str(pair.get('token0_address', '')).strip()
        token1_address = str(pair.get('token1_address', '')).strip()
        if not (_is_evm_address(pair_address) and _is_evm_address(token0_address) and _is_evm_address(token1_address)):
            continue
        pairs.append(pair)

    return {'tokens': tokens, 'pairs': pairs}


def _token_entry(symbol: str, name: str, decimals: int, address: str, source: str) -> dict:
    return {
        'symbol': symbol,
        'name': name,
        'address': address,
        'decimals': decimals,
        'source': source
    }


def _append_registry_collaterals(tokens: list[dict], deployed_entry: dict) -> list[dict]:
    configured = deployed_entry.get('collaterals', [])
    if not isinstance(configured, list):
        return tokens

    existing = {
        str(token.get('address', '')).lower()
        for token in tokens
        if isinstance(token, dict) and _is_evm_address(str(token.get('address', '')))
    }

    for item in configured:
        if not isinstance(item, dict):
            continue
        address = str(item.get('token', '')).strip()
        if not _is_evm_address(address):
            continue
        address_lower = address.lower()
        if address_lower in existing:
            continue
        symbol = str(item.get('symbol', '')).strip() or f'TKN{address[-4:]}'
        decimals_raw = item.get('decimals', 18)
        try:
            decimals = int(decimals_raw)
        except (TypeError, ValueError):
            decimals = 18
        tokens.append(
            _token_entry(
                symbol,
                f'{symbol} collateral',
                decimals,
                address,
                'deployed.collaterals'
            )
        )
        existing.add(address_lower)

    return tokens


def _append_registry_targets(tokens: list[dict], deployed_entry: dict) -> list[dict]:
    configured = deployed_entry.get('targets', [])
    if not isinstance(configured, list):
        return tokens

    existing = {
        str(token.get('address', '')).lower()
        for token in tokens
        if isinstance(token, dict) and _is_evm_address(str(token.get('address', '')))
    }

    for item in configured:
        if not isinstance(item, dict):
            continue
        address = str(item.get('token', '')).strip()
        if not _is_evm_address(address):
            continue
        address_lower = address.lower()
        if address_lower in existing:
            continue
        symbol = str(item.get('symbol', '')).strip() or f'TKN{address[-4:]}'
        decimals_raw = item.get('decimals', 18)
        try:
            decimals = int(decimals_raw)
        except (TypeError, ValueError):
            decimals = 18
        tokens.append(
            _token_entry(
                symbol,
                f'{symbol} target',
                decimals,
                address,
                'deployed.targets'
            )
        )
        existing.add(address_lower)

    return tokens


def _target_pairs_from_registry(deployed_entry: dict, checked_at: str) -> list[dict]:
    configured = deployed_entry.get('targets', [])
    if not isinstance(configured, list):
        return []

    contracts = deployed_entry.get('contracts', {})
    if not isinstance(contracts, dict):
        return []

    musd = str(contracts.get('musd', '')).strip()
    if not _is_evm_address(musd):
        return []

    output: list[dict] = []
    seen: set[str] = set()
    for item in configured:
        if not isinstance(item, dict):
            continue

        pair_address = str(item.get('pair', '')).strip()
        token_address = str(item.get('token', '')).strip()
        if not (_is_evm_address(pair_address) and _is_evm_address(token_address)):
            continue

        key = pair_address.lower()
        if key in seen:
            continue
        seen.add(key)

        symbol = str(item.get('symbol', '')).strip() or f'TKN{token_address[-4:]}'
        output.append(
            {
                'pair_address': pair_address,
                'token0_address': musd,
                'token1_address': token_address,
                'token0_symbol': 'mUSD',
                'token1_symbol': symbol,
                'reserve0_decimal': '0',
                'reserve1_decimal': '0',
                'checked_at': checked_at
            }
        )

    return output


def _merge_tokens_with_previous(current_tokens: list[dict], previous_tokens: list[dict]) -> list[dict]:
    merged: dict[str, dict] = {}

    def put_token(token: dict) -> None:
        if not isinstance(token, dict):
            return
        address = str(token.get('address', '')).strip()
        if not _is_evm_address(address):
            return
        merged[address.lower()] = token

    for token in current_tokens:
        put_token(token)
    for token in previous_tokens:
        put_token(token)

    return list(merged.values())


def _resolve_tokens(spec: dict, contracts: dict, deployed_entry: dict) -> list[dict]:
    musd = contracts.get('musd', 'unconfigured-musd')
    if spec['chain_key'] == 'hardhat-local':
        token_a = contracts.get('tokenA', 'local-weth')
        token_b = contracts.get('tokenB', 'local-wbtc')
        collateral = contracts.get('collateral', 'local-usdc')
        tokens = [
            _token_entry('mUSD', 'Musical USD', 18, musd, 'contracts.musd'),
            _token_entry('USDC', 'USD Coin (local collateral)', 6, collateral, 'contracts.collateral'),
            _token_entry('WETH', 'Wrapped Ether', 18, token_a, 'contracts.tokenA'),
            _token_entry('WBTC', 'Wrapped Bitcoin', 8, token_b, 'contracts.tokenB'),
        ]
        return _append_registry_targets(_append_registry_collaterals(tokens, deployed_entry), deployed_entry)

    tokens = [_token_entry('mUSD', 'Musical USD', 18, musd, 'contracts.musd')]
    for wrapped in CANONICAL_WRAPPED_BY_CHAIN.get(spec['chain_key'], []):
        address = str(wrapped.get('address', '')).strip()
        if not _is_evm_address(address):
            continue
        tokens.append(
            _token_entry(
                str(wrapped.get('symbol', '')).strip() or 'WRAPPED',
                str(wrapped.get('name', '')).strip() or 'Wrapped Asset',
                int(wrapped.get('decimals', 18)),
                address,
                'defaults'
            )
        )
    for token in STATIC_CHAIN_TOKENS.get(spec['chain_key'], []):
        address = str(token.get('address', '')).strip()
        if not _is_evm_address(address):
            continue
        tokens.append(
            _token_entry(
                str(token.get('symbol', '')).strip() or 'TOKEN',
                str(token.get('name', '')).strip() or 'Token',
                int(token.get('decimals', 18)),
                address,
                'static'
            )
        )

    return _append_registry_targets(_append_registry_collaterals(tokens, deployed_entry), deployed_entry)


def _filter_evm_pairs(pairs: list[dict]) -> list[dict]:
    output: list[dict] = []
    for pair in pairs:
        if not isinstance(pair, dict):
            continue
        pair_address = str(pair.get('pair_address', '')).strip()
        token0_address = str(pair.get('token0_address', '')).strip()
        token1_address = str(pair.get('token1_address', '')).strip()
        if not (_is_evm_address(pair_address) and _is_evm_address(token0_address) and _is_evm_address(token1_address)):
            continue
        output.append(pair)
    return output


def _merge_pair_lists(primary_pairs: list[dict], secondary_pairs: list[dict]) -> list[dict]:
    merged: dict[str, dict] = {}
    for pair in primary_pairs + secondary_pairs:
        if not isinstance(pair, dict):
            continue
        pair_address = str(pair.get('pair_address', '')).strip().lower()
        if not pair_address:
            continue
        merged[pair_address] = pair
    return list(merged.values())


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
    previous_generated = _read_previous_generated_registry()
    generated_at = datetime.now(timezone.utc).isoformat()

    chains: list[dict] = []
    for spec in CHAIN_SPECS:
        previous_chain = previous_generated.get(spec['chain_key'], {})
        pair_seed = _read_pair_seed(spec['network'])
        deployed_entry = deployed.get(spec['network'], {})
        target_pairs = _target_pairs_from_registry(deployed_entry, generated_at)
        contracts = deployed_entry.get('contracts', {})
        if not isinstance(contracts, dict):
            contracts = {}
        fees_cfg = deployed_entry.get('fees', {})
        if not isinstance(fees_cfg, dict):
            fees_cfg = {}

        stabilizer = str(contracts.get('stabilizer', '')).strip()
        resonance_vault = str(contracts.get('resonanceVault', '')).strip()
        swap_fee_bps = _safe_int(fees_cfg.get('swapFeeBps', os.getenv('SWAP_FEE_BPS', '30')), 30)
        protocol_fee_bps = _safe_int(fees_cfg.get('protocolFeeBps', os.getenv('PROTOCOL_FEE_BPS', '5')), 5)
        chain_entry = {
            'chain_key': spec['chain_key'],
            'chain_id': spec['chain_id'],
            'name': spec['name'],
            'network': spec['network'],
            'rpc_env_key': spec['rpc_env_key'],
            'default_rpc_url': spec['default_rpc_url'],
            'amm': {
                'swap_fee_bps': swap_fee_bps,
                'protocol_fee_bps': protocol_fee_bps
            },
            'contracts': {
                'musd': contracts.get('musd', ''),
                'stabilizer': stabilizer,
                'oracle': contracts.get('oracle', ''),
                'harmony_factory': contracts.get('harmonyFactory', ''),
                'harmony_router': contracts.get('harmonyRouter', ''),
                'resonance_vault': contracts.get('resonanceVault', '')
            },
            'indexer': {
                'pair_addresses': [],
                'stabilizer_addresses': [stabilizer] if _is_evm_address(stabilizer) else [],
                'vault_addresses': [resonance_vault] if _is_evm_address(resonance_vault) else [],
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
            'tokens': _resolve_tokens(spec, contracts, deployed_entry),
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
                filtered_pairs = _filter_evm_pairs(pairs)
                chain_entry['pairs'] = filtered_pairs
                chain_entry['indexer']['pair_addresses'] = [
                    str(pair.get('pair_address', '')).strip()
                    for pair in filtered_pairs
                    if isinstance(pair, dict)
                ]
                chain_entry['network_health'] = health
            except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as exc:
                previous_pairs = previous_chain.get('pairs') if isinstance(previous_chain.get('pairs'), list) else []
                seed_pairs = pair_seed.get('pairs') if isinstance(pair_seed.get('pairs'), list) else []
                fallback_pairs = _merge_pair_lists(previous_pairs, seed_pairs)
                fallback_pairs = _merge_pair_lists(target_pairs, fallback_pairs)
                source_parts: list[str] = []
                if previous_pairs:
                    source_parts.append('previous')
                if seed_pairs:
                    source_parts.append('seed')
                if target_pairs:
                    source_parts.append('targets')
                fallback_source = '+'.join(source_parts) if source_parts else 'none'

                seed_tokens = pair_seed.get('tokens') if isinstance(pair_seed.get('tokens'), list) else []
                if seed_tokens:
                    chain_entry['tokens'] = _merge_tokens_with_previous(chain_entry['tokens'], seed_tokens)
                if fallback_pairs:
                    previous_tokens = previous_chain.get('tokens') if isinstance(previous_chain.get('tokens'), list) else []
                    chain_entry['tokens'] = _merge_tokens_with_previous(chain_entry['tokens'], previous_tokens)
                    filtered_fallback_pairs = _filter_evm_pairs(fallback_pairs)
                    chain_entry['pairs'] = filtered_fallback_pairs
                    chain_entry['indexer']['pair_addresses'] = [
                        str(pair.get('pair_address', '')).strip()
                        for pair in filtered_fallback_pairs
                        if isinstance(pair, dict)
                    ]
                    chain_entry['network_health'] = {
                        'rpc_connected': False,
                        'latest_block': None,
                        'checked_at': generated_at,
                        'discovery_status': f'fallback-{fallback_source}: {exc}',
                        'fallback_pair_count': len(filtered_fallback_pairs)
                    }
                else:
                    chain_entry['network_health'] = {
                        'rpc_connected': False,
                        'latest_block': None,
                        'checked_at': generated_at,
                        'discovery_status': f'error: {exc}'
                    }
        else:
            previous_pairs = previous_chain.get('pairs') if isinstance(previous_chain.get('pairs'), list) else []
            seed_pairs = pair_seed.get('pairs') if isinstance(pair_seed.get('pairs'), list) else []
            fallback_pairs = _merge_pair_lists(previous_pairs, seed_pairs)
            fallback_pairs = _merge_pair_lists(target_pairs, fallback_pairs)
            source_parts: list[str] = []
            if previous_pairs:
                source_parts.append('previous')
            if seed_pairs:
                source_parts.append('seed')
            if target_pairs:
                source_parts.append('targets')
            fallback_source = '+'.join(source_parts) if source_parts else 'none'

            seed_tokens = pair_seed.get('tokens') if isinstance(pair_seed.get('tokens'), list) else []
            if seed_tokens:
                chain_entry['tokens'] = _merge_tokens_with_previous(chain_entry['tokens'], seed_tokens)
            if fallback_pairs:
                previous_tokens = previous_chain.get('tokens') if isinstance(previous_chain.get('tokens'), list) else []
                chain_entry['tokens'] = _merge_tokens_with_previous(chain_entry['tokens'], previous_tokens)
                filtered_fallback_pairs = _filter_evm_pairs(fallback_pairs)
                chain_entry['pairs'] = filtered_fallback_pairs
                chain_entry['indexer']['pair_addresses'] = [
                    str(pair.get('pair_address', '')).strip()
                    for pair in filtered_fallback_pairs
                    if isinstance(pair, dict)
                ]
                chain_entry['network_health'] = {
                    'rpc_connected': False,
                    'latest_block': None,
                    'checked_at': generated_at,
                    'discovery_status': f'fallback-{fallback_source}: rpc-url-missing',
                    'fallback_pair_count': len(filtered_fallback_pairs)
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
        'version': 3,
        'generated_at': generated_at,
        'source': 'packages/contracts/deploy/address-registry.*.json + live-rpc-pair-discovery + optional pair-seeds.*.json fallback',
        'chains': chains
    }


def main() -> None:
    _load_known_env_files()
    registry = build_registry()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(registry, indent=2) + '\n', encoding='utf-8')
    print(f'generated {OUT_PATH}')


if __name__ == '__main__':
    main()
