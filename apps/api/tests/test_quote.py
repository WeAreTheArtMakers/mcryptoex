import unittest
from decimal import Decimal

from apps.api.quote_engine import build_quote


class QuoteEndpointTests(unittest.TestCase):
    def test_returns_direct_musd_route(self) -> None:
        result = build_quote(
            chain_id=31337,
            token_in='mUSD',
            token_out='WETH',
            amount_in=Decimal('1000'),
            slippage_bps=50
        )

        self.assertEqual(result['route'], ['mUSD', 'WETH'])
        self.assertGreater(Decimal(result['expected_out']), Decimal('0'))
        self.assertLess(Decimal(result['min_out']), Decimal(result['expected_out']))

    def test_routes_non_musd_pair_through_musd(self) -> None:
        result = build_quote(
            chain_id=31337,
            token_in='WBTC',
            token_out='WETH',
            amount_in=Decimal('1'),
            slippage_bps=100
        )

        self.assertEqual(result['route'], ['WBTC', 'mUSD', 'WETH'])
