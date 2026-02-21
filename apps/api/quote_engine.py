from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass
from decimal import Decimal, ROUND_DOWN

from .chain_registry import load_chain_registry


class QuoteEngineError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass
class PairState:
    pair_address: str
    token0_symbol: str
    token1_symbol: str
    reserve0: Decimal
    reserve1: Decimal


@dataclass
class ChainLiquidityState:
    chain_id: int
    symbols: set[str]
    canonical_symbols: dict[str, str]
    token_decimals: dict[str, int]
    pairs: list[PairState]
    swap_fee_bps: int
    protocol_fee_bps: int


def _normalize_pool_address(value: str) -> str:
    return str(value or '').strip().lower()


def _is_evm_pool_address(value: str) -> bool:
    return bool(re.fullmatch(r'0x[a-f0-9]{40}', _normalize_pool_address(value)))


def _parse_canonical_pool_allowlist() -> tuple[set[str], set[tuple[int, str]]]:
    raw = str(os.getenv('CANONICAL_POOL_ALLOWLIST', '')).strip()
    global_allowlist: set[str] = set()
    chain_allowlist: set[tuple[int, str]] = set()
    if not raw:
        return global_allowlist, chain_allowlist

    for chunk in re.split(r'[,;\s]+', raw):
        item = chunk.strip()
        if not item:
            continue
        if ':' in item:
            chain_raw, addr_raw = item.split(':', 1)
            addr = _normalize_pool_address(addr_raw)
            if not _is_evm_pool_address(addr):
                continue
            try:
                chain_value = int(chain_raw.strip())
            except (TypeError, ValueError):
                continue
            if chain_value <= 0:
                continue
            chain_allowlist.add((chain_value, addr))
            continue

        addr = _normalize_pool_address(item)
        if _is_evm_pool_address(addr):
            global_allowlist.add(addr)

    return global_allowlist, chain_allowlist


def _pair_symbol_key(token0_symbol: str, token1_symbol: str) -> tuple[str, str]:
    token0 = str(token0_symbol or '').strip().upper()
    token1 = str(token1_symbol or '').strip().upper()
    if token0 <= token1:
        return token0, token1
    return token1, token0


def _pair_liquidity_score(pair: PairState) -> Decimal:
    if pair.reserve0 <= 0 or pair.reserve1 <= 0:
        return Decimal('0')
    return pair.reserve0 * pair.reserve1


def _select_canonical_pairs(chain_id: int, pairs: list[PairState]) -> list[PairState]:
    if not pairs:
        return []

    global_allowlist, chain_allowlist = _parse_canonical_pool_allowlist()
    grouped: dict[tuple[str, str], list[PairState]] = {}
    for pair in pairs:
        symbol_key = _pair_symbol_key(pair.token0_symbol, pair.token1_symbol)
        if not symbol_key[0] or not symbol_key[1]:
            continue
        grouped.setdefault(symbol_key, []).append(pair)

    selected: list[PairState] = []
    for group in grouped.values():
        if not group:
            continue
        allowlisted_group = [
            pair
            for pair in group
            if (
                (_normalize_pool_address(pair.pair_address) in global_allowlist) or
                ((chain_id, _normalize_pool_address(pair.pair_address)) in chain_allowlist)
            )
        ]
        candidates = allowlisted_group if allowlisted_group else group
        candidates.sort(
            key=lambda pair: (
                _pair_liquidity_score(pair),
                _normalize_pool_address(pair.pair_address)
            ),
            reverse=True
        )
        selected.append(candidates[0])

    return selected


class LiquidityDepthCache:
    def __init__(self, ttl_seconds: int) -> None:
        self.ttl_seconds = ttl_seconds
        self._expires_at = 0.0
        self._chains: dict[int, ChainLiquidityState] = {}

    def get_chain(self, chain_id: int) -> ChainLiquidityState | None:
        now = time.time()
        if now >= self._expires_at:
            self._refresh(now)
        return self._chains.get(chain_id)

    def _refresh(self, now: float) -> None:
        load_chain_registry.cache_clear()
        data = load_chain_registry()
        chains_payload = data.get('chains', [])
        chains: dict[int, ChainLiquidityState] = {}

        for chain in chains_payload:
            try:
                chain_id = int(chain.get('chain_id', 0))
            except (TypeError, ValueError):
                continue
            if chain_id <= 0:
                continue

            tokens = chain.get('tokens', [])
            canonical: dict[str, str] = {}
            symbols: set[str] = set()
            token_decimals: dict[str, int] = {}
            if isinstance(tokens, list):
                for token in tokens:
                    if not isinstance(token, dict):
                        continue
                    symbol = str(token.get('symbol', '')).strip()
                    if not symbol:
                        continue
                    upper = symbol.upper()
                    symbols.add(upper)
                    canonical[upper] = symbol
                    try:
                        decimals = int(token.get('decimals', 18))
                    except Exception:
                        decimals = 18
                    if decimals < 0:
                        decimals = 0
                    if decimals > 36:
                        decimals = 36
                    token_decimals[upper] = decimals

            swap_fee_bps = 30
            protocol_fee_bps = 5
            amm_cfg = chain.get('amm', {})
            if isinstance(amm_cfg, dict):
                try:
                    swap_fee_bps = int(amm_cfg.get('swap_fee_bps', 30))
                except (TypeError, ValueError):
                    swap_fee_bps = 30
                try:
                    protocol_fee_bps = int(amm_cfg.get('protocol_fee_bps', 5))
                except (TypeError, ValueError):
                    protocol_fee_bps = 5
            if protocol_fee_bps < 0:
                protocol_fee_bps = 0
            if protocol_fee_bps > swap_fee_bps:
                protocol_fee_bps = swap_fee_bps

            parsed_pairs: list[PairState] = []
            pairs = chain.get('pairs', [])
            if isinstance(pairs, list):
                for pair in pairs:
                    if not isinstance(pair, dict):
                        continue
                    token0 = str(pair.get('token0_symbol', '')).strip()
                    token1 = str(pair.get('token1_symbol', '')).strip()
                    if not token0 or not token1:
                        continue
                    try:
                        reserve0 = Decimal(str(pair.get('reserve0_decimal', '0')))
                        reserve1 = Decimal(str(pair.get('reserve1_decimal', '0')))
                    except Exception:
                        continue
                    if reserve0 <= 0 or reserve1 <= 0:
                        continue
                    parsed_pairs.append(
                        PairState(
                            pair_address=str(pair.get('pair_address', '')),
                            token0_symbol=token0,
                            token1_symbol=token1,
                            reserve0=reserve0,
                            reserve1=reserve1
                        )
                    )
                    symbols.add(token0.upper())
                    symbols.add(token1.upper())
                    canonical.setdefault(token0.upper(), token0)
                    canonical.setdefault(token1.upper(), token1)

            canonical_pairs = _select_canonical_pairs(chain_id, parsed_pairs)
            active_pairs = canonical_pairs if canonical_pairs else parsed_pairs

            chains[chain_id] = ChainLiquidityState(
                chain_id=chain_id,
                symbols=symbols,
                canonical_symbols=canonical,
                token_decimals=token_decimals,
                pairs=active_pairs,
                swap_fee_bps=swap_fee_bps,
                protocol_fee_bps=protocol_fee_bps
            )

        self._chains = chains
        self._expires_at = now + self.ttl_seconds


_cache = LiquidityDepthCache(ttl_seconds=int(os.getenv('QUOTE_CACHE_TTL_SECONDS', '20')))
_allow_static_fallback_global = os.getenv('QUOTE_ALLOW_STATIC_FALLBACK', 'false').lower() == 'true'


def _amount_out_constant_product(amount_in: Decimal, reserve_in: Decimal, reserve_out: Decimal, fee_bps: int) -> Decimal:
    fee_multiplier = Decimal(10_000 - fee_bps)
    numerator = amount_in * fee_multiplier * reserve_out
    denominator = (reserve_in * Decimal(10_000)) + (amount_in * fee_multiplier)
    if denominator <= 0:
        return Decimal('0')
    return numerator / denominator


def _route_amount(
    *,
    state: ChainLiquidityState,
    token_in: str,
    token_out: str,
    amount_in: Decimal
) -> tuple[Decimal, Decimal] | None:
    token_in_upper = token_in.upper()
    token_out_upper = token_out.upper()
    best_out = Decimal('0')
    best_depth = Decimal('0')

    for pair in state.pairs:
        pair_token0_upper = pair.token0_symbol.upper()
        pair_token1_upper = pair.token1_symbol.upper()

        if {pair_token0_upper, pair_token1_upper} != {token_in_upper, token_out_upper}:
            continue

        if token_in_upper == pair_token0_upper:
            reserve_in = pair.reserve0
            reserve_out = pair.reserve1
        else:
            reserve_in = pair.reserve1
            reserve_out = pair.reserve0

        out = _amount_out_constant_product(amount_in, reserve_in, reserve_out, state.swap_fee_bps)
        if out > best_out:
            best_out = out
            best_depth = min(reserve_in, reserve_out)

    if best_out <= 0:
        return None
    return best_out, best_depth


def _legacy_amount(token_in: str, token_out: str, amount_in: Decimal) -> Decimal:
    rate = Decimal('1')
    if token_in != token_out:
        if token_in.upper() == 'MUSD':
            rate = Decimal('0.0003') if token_out.upper() in {'WETH', 'WSOL'} else Decimal('0.00002')
        elif token_out.upper() == 'MUSD':
            rate = Decimal('3300') if token_in.upper() in {'WETH', 'WSOL'} else Decimal('52000')
        else:
            rate = Decimal('0.06')
    return amount_in * rate


def _format_amount_for_decimals(value: Decimal, decimals: int) -> str:
    if decimals <= 0:
        quantized = value.quantize(Decimal('1'), rounding=ROUND_DOWN)
    else:
        quantized = value.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_DOWN)

    text = format(quantized, 'f')
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    return text or '0'


def build_quote(
    *,
    chain_id: int,
    token_in: str,
    token_out: str,
    amount_in: Decimal,
    slippage_bps: int
) -> dict:
    token_in_clean = token_in.strip()
    token_out_clean = token_out.strip()
    if amount_in <= 0:
        raise QuoteEngineError(422, 'amount_in must be greater than zero')
    if token_in_clean.upper() == token_out_clean.upper():
        raise QuoteEngineError(422, 'token_in and token_out cannot be the same')

    state = _cache.get_chain(chain_id)
    if state is None:
        raise QuoteEngineError(404, f'chain_id={chain_id} is not configured')

    token_in_upper = token_in_clean.upper()
    token_out_upper = token_out_clean.upper()

    if token_in_upper not in state.symbols:
        raise QuoteEngineError(422, f'token_in={token_in_clean} is not registered for chain_id={chain_id}')
    if token_out_upper not in state.symbols:
        raise QuoteEngineError(422, f'token_out={token_out_clean} is not registered for chain_id={chain_id}')

    canonical_in = state.canonical_symbols.get(token_in_upper, token_in_clean)
    canonical_out = state.canonical_symbols.get(token_out_upper, token_out_clean)

    direct = _route_amount(
        state=state,
        token_in=canonical_in,
        token_out=canonical_out,
        amount_in=amount_in
    )

    via_musd: tuple[Decimal, Decimal] | None = None
    musd_symbol = state.canonical_symbols.get('MUSD', 'mUSD')
    if token_in_upper != 'MUSD' and token_out_upper != 'MUSD':
        first_leg = _route_amount(
            state=state,
            token_in=canonical_in,
            token_out=musd_symbol,
            amount_in=amount_in
        )
        if first_leg is not None:
            second_leg = _route_amount(
                state=state,
                token_in=musd_symbol,
                token_out=canonical_out,
                amount_in=first_leg[0]
            )
            if second_leg is not None:
                via_musd = (second_leg[0], min(first_leg[1], second_leg[1]))

    expected_out = Decimal('0')
    route: list[str] = []
    route_depth = Decimal('0')
    liquidity_source = 'onchain-cache'

    if direct is not None:
        expected_out = direct[0]
        route = [canonical_in, canonical_out]
        route_depth = direct[1]

    if via_musd is not None and via_musd[0] > expected_out:
        expected_out = via_musd[0]
        route = [canonical_in, musd_symbol, canonical_out]
        route_depth = via_musd[1]

    if expected_out <= 0:
        allow_static = _allow_static_fallback_global or chain_id == 31337
        if not allow_static:
            raise QuoteEngineError(
                422,
                (
                    f'no on-chain liquidity route for {canonical_in}->{canonical_out} on chain_id={chain_id}. '
                    'deploy router/factory + bootstrap pool liquidity for this pair first'
                )
            )
        liquidity_source = 'static-fallback'
        expected_out = _legacy_amount(canonical_in, canonical_out, amount_in)
        if token_in_upper == 'MUSD' or token_out_upper == 'MUSD':
            route = [canonical_in, canonical_out]
        else:
            route = [canonical_in, musd_symbol, canonical_out]

    min_out = expected_out * (Decimal(10_000 - slippage_bps) / Decimal(10_000))
    protocol_fee_amount_in = amount_in * Decimal(state.protocol_fee_bps) / Decimal(10_000)
    lp_fee_bps = max(0, state.swap_fee_bps - state.protocol_fee_bps)
    token_in_decimals = state.token_decimals.get(token_in_upper, 18)
    token_out_decimals = state.token_decimals.get(token_out_upper, 18)

    return {
        'chain_id': chain_id,
        'token_in': canonical_in,
        'token_out': canonical_out,
        'amount_in': _format_amount_for_decimals(amount_in, token_in_decimals),
        'expected_out': _format_amount_for_decimals(expected_out, token_out_decimals),
        'min_out': _format_amount_for_decimals(min_out, token_out_decimals),
        'slippage_bps': slippage_bps,
        'route': route,
        'route_depth': str(route_depth),
        'liquidity_source': liquidity_source,
        'total_fee_bps': state.swap_fee_bps,
        'protocol_fee_bps': state.protocol_fee_bps,
        'lp_fee_bps': lp_fee_bps,
        'protocol_fee_amount_in': _format_amount_for_decimals(protocol_fee_amount_in, token_in_decimals),
        'engine': 'harmony-engine-v2'
    }
