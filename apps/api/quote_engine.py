from __future__ import annotations

from decimal import Decimal


def build_quote(
    *,
    chain_id: int,
    token_in: str,
    token_out: str,
    amount_in: Decimal,
    slippage_bps: int
) -> dict:
    rate = Decimal('1')
    if token_in != token_out:
        if token_in == 'mUSD':
            rate = Decimal('0.0003') if token_out in {'WETH', 'WSOL'} else Decimal('0.00002')
        elif token_out == 'mUSD':
            rate = Decimal('3300') if token_in in {'WETH', 'WSOL'} else Decimal('52000')
        else:
            rate = Decimal('0.06')

    expected_out = amount_in * rate
    min_out = expected_out * (Decimal(10_000 - slippage_bps) / Decimal(10_000))
    route = [token_in, token_out] if 'mUSD' in {token_in, token_out} else [token_in, 'mUSD', token_out]

    return {
        'chain_id': chain_id,
        'token_in': token_in,
        'token_out': token_out,
        'amount_in': str(amount_in),
        'expected_out': str(expected_out),
        'min_out': str(min_out),
        'slippage_bps': slippage_bps,
        'route': route,
        'engine': 'harmony-engine-v2'
    }
