import unittest
from decimal import Decimal

from apps.api.quote_engine import QuoteEngineError, build_quote


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

    def test_rejects_unregistered_token(self) -> None:
        with self.assertRaises(QuoteEngineError):
            build_quote(
                chain_id=31337,
                token_in='INVALID',
                token_out='mUSD',
                amount_in=Decimal('1'),
                slippage_bps=100
            )

    def test_rejects_unknown_chain(self) -> None:
        with self.assertRaises(QuoteEngineError) as ctx:
            build_quote(
                chain_id=999999,
                token_in='mUSD',
                token_out='WETH',
                amount_in=Decimal('1'),
                slippage_bps=100
            )
        self.assertEqual(ctx.exception.status_code, 404)

    def test_rejects_same_token(self) -> None:
        with self.assertRaises(QuoteEngineError) as ctx:
            build_quote(
                chain_id=31337,
                token_in='mUSD',
                token_out='mUSD',
                amount_in=Decimal('1'),
                slippage_bps=100
            )
        self.assertEqual(ctx.exception.status_code, 422)

    def test_requires_onchain_liquidity_for_non_local_chains(self) -> None:
        with self.assertRaises(QuoteEngineError) as ctx:
            build_quote(
                chain_id=11155111,
                token_in='WETH',
                token_out='mUSD',
                amount_in=Decimal('1'),
                slippage_bps=100
            )
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn('bootstrap pool liquidity', str(ctx.exception))
