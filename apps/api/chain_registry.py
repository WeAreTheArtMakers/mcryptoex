from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import get_settings


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _resolve_registry_path(path_value: str) -> Path:
    path = Path(path_value)
    if path.is_absolute():
        return path
    return _repo_root() / path


@lru_cache(maxsize=1)
def load_chain_registry() -> dict[str, Any]:
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
        tokens = chain.get('tokens') if isinstance(chain.get('tokens'), list) else []
        tokens_by_chain[chain_id_key] = tokens

        networks.append(
            {
                'chain_id': chain_id,
                'chain_key': str(chain.get('chain_key', '')),
                'name': str(chain.get('name', chain_id_key)),
                'network': str(chain.get('network', '')),
                'token_count': len(tokens)
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
