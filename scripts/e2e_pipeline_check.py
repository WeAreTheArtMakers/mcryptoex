#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from decimal import Decimal


def http_get(url: str) -> dict:
    req = urllib.request.Request(url=url, method='GET')
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read().decode('utf-8'))


def http_post(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url=url,
        method='POST',
        data=body,
        headers={'Content-Type': 'application/json'}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def wait_until(fn, timeout_seconds: int, interval_seconds: float, label: str):
    started = time.time()
    last_error = None
    while time.time() - started < timeout_seconds:
        try:
            result = fn()
            if result:
                return result
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        time.sleep(interval_seconds)

    if last_error is not None:
        raise TimeoutError(f'{label} timed out. last_error={last_error}') from last_error
    raise TimeoutError(f'{label} timed out.')


def main() -> None:
    parser = argparse.ArgumentParser(description='Phase 3 swap note -> ledger/analytics pipeline check')
    parser.add_argument('--api-base', default='http://localhost:8500', help='Tempo API base URL')
    parser.add_argument('--timeout', type=int, default=120, help='Timeout seconds')
    args = parser.parse_args()

    api = args.api_base.rstrip('/')

    print('[check] waiting for API readiness...')
    wait_until(
        fn=lambda: http_get(f'{api}/health/ready').get('status') == 'ready',
        timeout_seconds=args.timeout,
        interval_seconds=2,
        label='api readiness'
    )

    tx_hash = f"0x{uuid.uuid4().hex}{uuid.uuid4().hex[:32]}"
    payload = {
        'chain_id': 31337,
        'tx_hash': tx_hash,
        'user_address': '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        'pool_address': '0x1111111111111111111111111111111111111111',
        'token_in': 'mUSD',
        'token_out': 'WETH',
        'amount_in': '125.0',
        'amount_out': '0.0375',
        'fee_usd': '0.375',
        'gas_used': '117104',
        'gas_cost_usd': '0.24',
        'protocol_revenue_usd': '0.15',
        'block_number': 42,
        'action': 'SWAP'
    }

    print('[check] publishing swap note...')
    published = http_post(f'{api}/debug/emit-swap-note', payload)
    note_id = published['note_id']

    print(f'[check] note published note_id={note_id}')

    def ledger_has_note() -> bool:
        data = http_get(f'{api}/ledger/recent?limit=200')
        rows = data.get('rows', [])
        return any(row.get('note_id') == note_id for row in rows)

    wait_until(
        fn=ledger_has_note,
        timeout_seconds=args.timeout,
        interval_seconds=2,
        label='ledger ingestion'
    )
    print('[check] ledger row detected')

    def analytics_has_volume() -> bool:
        data = http_get(f'{api}/analytics?minutes=180')
        rows = data.get('volume_by_chain_token', [])
        for row in rows:
            if int(row.get('chain_id', 0)) != 31337:
                continue
            try:
                if Decimal(str(row.get('volume', '0'))) > 0:
                    return True
            except Exception:  # noqa: BLE001
                continue
        return False

    wait_until(
        fn=analytics_has_volume,
        timeout_seconds=args.timeout,
        interval_seconds=3,
        label='analytics rollup'
    )
    print('[check] analytics rollup detected')

    print(
        json.dumps(
            {
                'status': 'ok',
                'checked_at': datetime.now(timezone.utc).isoformat(),
                'api_base': api,
                'note_id': note_id,
                'tx_hash': tx_hash
            },
            indent=2
        )
    )


if __name__ == '__main__':
    main()
