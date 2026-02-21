from __future__ import annotations

import copy
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import get_settings

STATIC_CHAIN_TOKENS: dict[int, list[dict[str, Any]]] = {
    97: [
        {
            'symbol': 'MODX',
            'name': 'modX Token',
            'address': '0xB6322eD8561604Ca2A1b9c17e4d02B957EB242fe',
            'decimals': 18,
            'source': 'static.bnb-testnet'
        }
    ]
}


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _resolve_registry_path(path_value: str) -> Path:
    path = Path(path_value)
    if path.is_absolute():
        return path
    return _repo_root() / path


@lru_cache(maxsize=1)
def _load_chain_registry_cached() -> dict[str, Any]:
    settings = get_settings()
    path = _resolve_registry_path(settings.chain_registry_path)
    if not path.exists():
        return {'version': 0, 'generated_at': None, 'chains': []}

    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(payload, dict):
            return {'version': 0, 'generated_at': None, 'chains': []}
        if not isinstance(payload.get('chains'), list):
            payload['chains'] = []
        return payload
    except json.JSONDecodeError:
        return {'version': 0, 'generated_at': None, 'chains': []}


def load_chain_registry() -> dict[str, Any]:
    # Return a defensive copy so downstream code cannot mutate shared cache state.
    return copy.deepcopy(_load_chain_registry_cached())


load_chain_registry.cache_clear = _load_chain_registry_cached.cache_clear  # type: ignore[attr-defined]


def _is_evm_address(value: str) -> bool:
    return bool(re.fullmatch(r'0x[a-fA-F0-9]{40}', value))


def _normalize_token(token: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(token)
    normalized['symbol'] = str(normalized.get('symbol', '')).strip()
    normalized['address'] = str(normalized.get('address', '')).strip()
    try:
        decimals = int(normalized.get('decimals', 18))
    except (TypeError, ValueError):
        decimals = 18
    normalized['decimals'] = max(0, min(36, decimals))
    return normalized


def _token_priority(token: dict[str, Any]) -> tuple[int, int]:
    address = str(token.get('address', '')).strip()
    source = str(token.get('source', '')).strip().lower()

    score = 0
    if _is_evm_address(address):
        score += 4
    if source.startswith('contracts'):
        score += 3
    elif source.startswith('deployed'):
        score += 2
    elif source.startswith('pair-discovery'):
        score += 1
    elif source.startswith('defaults'):
        score -= 1

    # Prefer non-bridge placeholder addresses when symbol is duplicated.
    if address.startswith('bridge-'):
        score -= 2

    return score, len(address)


def _dedupe_tokens(tokens: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    for token in tokens:
        symbol = str(token.get('symbol', '')).strip()
        if not symbol:
            continue
        key = symbol.upper()
        candidate = dict(token)
        current = selected.get(key)
        if current is None:
            selected[key] = candidate
            continue

        if _token_priority(candidate) > _token_priority(current):
            selected[key] = candidate

    # Keep deterministic ordering for stable UI rendering.
    return [dict(selected[key]) for key in sorted(selected.keys())]


def tokens_payload() -> dict[str, Any]:
    data = load_chain_registry()
    chains = data.get('chains', [])

    tokens_by_chain: dict[str, list[dict[str, Any]]] = {}
    networks: list[dict[str, Any]] = []

    for chain in chains:
        chain_id = int(chain.get('chain_id', 0))
        if chain_id <= 0:
            continue

        chain_id_key = str(chain_id)
        raw_tokens = chain.get('tokens') if isinstance(chain.get('tokens'), list) else []
        merged_tokens = [_normalize_token(t) for t in raw_tokens if isinstance(t, dict)]
        static_tokens = STATIC_CHAIN_TOKENS.get(chain_id, [])
        merged_tokens.extend([_normalize_token(t) for t in static_tokens if isinstance(t, dict)])
        tokens = _dedupe_tokens(merged_tokens)
        executable_tokens = [
            token
            for token in tokens
            if _is_evm_address(str(token.get('address', '')).strip())
        ]
        tokens_by_chain[chain_id_key] = executable_tokens

        contracts = chain.get('contracts') if isinstance(chain.get('contracts'), dict) else {}
        network_health = chain.get('network_health') if isinstance(chain.get('network_health'), dict) else {}
        pairs = chain.get('pairs') if isinstance(chain.get('pairs'), list) else []
        amm = chain.get('amm') if isinstance(chain.get('amm'), dict) else {}

        networks.append(
            {
                'chain_id': chain_id,
                'chain_key': str(chain.get('chain_key', '')),
                'name': str(chain.get('name', chain_id_key)),
                'network': str(chain.get('network', '')),
                'token_count': len(executable_tokens),
                'pair_count': len(pairs),
                'router_address': str(contracts.get('harmony_router', '')),
                'factory_address': str(contracts.get('harmony_factory', '')),
                'vault_address': str(contracts.get('resonance_vault', '')),
                'protocol_fee_receiver': str(contracts.get('resonance_vault', '')),
                'musd_address': str(contracts.get('musd', '')),
                'stabilizer_address': str(contracts.get('stabilizer', '')),
                'swap_fee_bps': int(amm.get('swap_fee_bps', 30)),
                'protocol_fee_bps': int(amm.get('protocol_fee_bps', 5)),
                'rpc_connected': bool(network_health.get('rpc_connected', False)),
                'latest_checked_block': network_health.get('latest_block')
            }
        )

    networks.sort(key=lambda item: item['chain_id'])

    return {
        'chains': tokens_by_chain,
        'networks': networks,
        'registry_version': data.get('version', 0),
        'generated_at': data.get('generated_at')
    }


def risk_assumptions_payload(chain_id: int) -> dict[str, Any] | None:
    data = load_chain_registry()
    for chain in data.get('chains', []):
        if int(chain.get('chain_id', 0)) != chain_id:
            continue
        assumptions = chain.get('trust_assumptions')
        if not isinstance(assumptions, list):
            assumptions = []
        return {
            'chain_id': chain_id,
            'chain_key': str(chain.get('chain_key', '')),
            'chain_name': str(chain.get('name', chain_id)),
            'assumptions': assumptions
        }
    return None
