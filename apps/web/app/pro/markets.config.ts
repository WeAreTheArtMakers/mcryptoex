import { MUSD_SYMBOL, configuredMarketBaseKeys, resolveTokenPreset } from './tokens.config';

export type ChainTokenInput = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  source?: string;
  is_wrapped?: boolean;
  underlying_symbol?: string;
};

export type PairInput = {
  chain_id: number;
  pool_address: string;
  token0_symbol: string;
  token1_symbol: string;
  reserve0_decimal: string;
  reserve1_decimal: string;
  swaps?: number;
  total_amount_in?: string;
  total_fee_usd?: string;
  last_swap_at?: string | null;
  canonical?: boolean;
  external?: boolean;
  source?: string;
};

export type TokenRegistryItem = {
  chainId: number;
  symbol: string;
  symbolUpper: string;
  displaySymbol: string;
  name: string;
  address: string;
  decimals: number;
  logoUrl?: string;
  isWrapped: boolean;
  underlyingSymbol?: string;
  riskFlags: string[];
  aliases: string[];
  isEvmAddress: boolean;
  source?: string;
};

export type PairStatsItem = {
  lastPrice: number | null;
  change24h: number | null;
  volume24h: number;
  lastSwapAt: string | null;
};

export type VenueMarketConfigRow = {
  id: string;
  chainId: number;
  pair: string;
  displayPair: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseDisplaySymbol: string;
  quoteDisplaySymbol: string;
  poolAddress: string;
  hasPool: boolean;
  lowLiquidity: boolean;
  warnings: string[];
  routeHint: string;
  tickSize: number;
  stepSize: number;
  minOrder: number;
  uiPrecisionPrice: number;
  uiPrecisionSize: number;
  maxTradeNotionalMusd: number;
  reserveBase: number;
  reserveQuote: number;
  swaps: number;
  volume24h: number;
  totalFeeUsd: number;
  lastSwapAt: string | null;
  last: number | null;
  change24h: number | null;
};

export type TokenRegistryBuildResult = {
  chainId: number;
  quoteSymbol: string;
  quoteToken: TokenRegistryItem | null;
  tokenBySymbol: Map<string, TokenRegistryItem>;
  tokens: TokenRegistryItem[];
};

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function normalizePoolAddress(value: string): string {
  return String(value || '').trim().toLowerCase();
}

export function pairId(chainId: number, poolAddress: string): string {
  return `${chainId}:${normalizePoolAddress(poolAddress)}`;
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

function tokenScore(token: ChainTokenInput): number {
  const address = String(token.address || '').trim();
  const source = String(token.source || '').toLowerCase();
  let score = 0;
  if (isEvmAddress(address)) score += 10;
  if (source.includes('contracts')) score += 5;
  if (source.includes('deployed')) score += 4;
  if (source.includes('pair-discovery')) score += 2;
  if (source.includes('defaults')) score -= 2;
  if (address.startsWith('bridge-')) score -= 3;
  if (address.startsWith('seed-')) score -= 2;
  if (address.startsWith('unconfigured-')) score -= 5;
  return score;
}

export function buildTokenRegistry(chainId: number, chainTokens: ChainTokenInput[]): TokenRegistryBuildResult {
  const selected = new Map<string, ChainTokenInput>();
  for (const token of chainTokens || []) {
    const symbolUpper = normalizeSymbol(token.symbol || '');
    if (!symbolUpper) continue;
    const current = selected.get(symbolUpper);
    if (!current || tokenScore(token) > tokenScore(current)) {
      selected.set(symbolUpper, token);
    }
  }

  const tokens: TokenRegistryItem[] = [];
  for (const [symbolUpper, token] of selected.entries()) {
    const preset = resolveTokenPreset(symbolUpper);
    const wrappedBySymbol = symbolUpper.startsWith('W') || symbolUpper.startsWith('WB');
    const isWrapped = Boolean(token.is_wrapped ?? preset?.isWrapped ?? wrappedBySymbol);
    const underlying = String(token.underlying_symbol || preset?.underlyingSymbol || '').trim() || undefined;
    const riskFlags = new Set<string>(preset?.riskFlags || []);
    if (isWrapped) riskFlags.add('wrapped');
    if (!isEvmAddress(token.address)) riskFlags.add('experimental');

    tokens.push({
      chainId,
      symbol: token.symbol,
      symbolUpper,
      displaySymbol: preset?.displaySymbol || token.symbol,
      name: token.name,
      address: token.address,
      decimals: Number.isFinite(Number(token.decimals)) ? Number(token.decimals) : 18,
      logoUrl: preset?.logoUrl,
      isWrapped,
      underlyingSymbol: underlying,
      riskFlags: Array.from(riskFlags),
      aliases: (preset?.aliases || []).map((item) => item.toUpperCase()),
      isEvmAddress: isEvmAddress(token.address),
      source: token.source
    });
  }

  tokens.sort((a, b) => {
    if (a.symbolUpper === MUSD_SYMBOL && b.symbolUpper !== MUSD_SYMBOL) return -1;
    if (b.symbolUpper === MUSD_SYMBOL && a.symbolUpper !== MUSD_SYMBOL) return 1;
    return a.symbolUpper.localeCompare(b.symbolUpper);
  });

  const tokenBySymbol = new Map<string, TokenRegistryItem>();
  for (const token of tokens) {
    tokenBySymbol.set(token.symbolUpper, token);
  }

  const quoteToken =
    tokenBySymbol.get(MUSD_SYMBOL) ||
    tokenBySymbol.get('MUSD'.toUpperCase()) ||
    tokenBySymbol.get('MUSD'.toLowerCase().toUpperCase()) ||
    null;
  const quoteSymbol = quoteToken?.symbol || 'mUSD';

  return {
    chainId,
    quoteSymbol,
    quoteToken,
    tokenBySymbol,
    tokens
  };
}

function resolveBaseSymbolForKey(key: string, tokenBySymbol: Map<string, TokenRegistryItem>): string | null {
  const preset = resolveTokenPreset(key);
  const preferred = preset?.preferredSymbols || [key];
  for (const symbol of preferred) {
    const candidate = tokenBySymbol.get(normalizeSymbol(symbol));
    if (candidate) return candidate.symbol;
  }
  const direct = tokenBySymbol.get(normalizeSymbol(key));
  return direct?.symbol || null;
}

function precisionFromDecimals(decimals: number, fallback: number): number {
  if (!Number.isFinite(decimals)) return fallback;
  return Math.min(8, Math.max(2, decimals));
}

export function buildVenueMarkets(params: {
  chainId: number;
  registry: TokenRegistryBuildResult;
  pairs: PairInput[];
  pairStatsById: Map<string, PairStatsItem>;
}): VenueMarketConfigRow[] {
  const { chainId, registry, pairs, pairStatsById } = params;
  const quoteSymbol = registry.quoteSymbol;
  const quoteUpper = normalizeSymbol(quoteSymbol);
  const quoteDisplay = 'mUSD';
  const stableMusdRails = new Set(['USDC', 'USDT']);
  const quoteDecimals = registry.quoteToken?.decimals ?? 18;
  const liquidityFloor = Math.max(1, n(process.env.NEXT_PUBLIC_LOW_LIQUIDITY_MUSD_THRESHOLD || '100'));

  const keyedPairs = (pairs || []).filter((pair) => Number(pair.chain_id) === chainId);
  const marketRows: VenueMarketConfigRow[] = [];

  for (const baseKey of configuredMarketBaseKeys()) {
    const baseSymbol = resolveBaseSymbolForKey(baseKey, registry.tokenBySymbol) || baseKey;
    const baseUpper = normalizeSymbol(baseSymbol);
    const baseToken = registry.tokenBySymbol.get(baseUpper) || null;
    if (!baseToken || !baseToken.isEvmAddress) {
      continue;
    }
    const baseDisplay = resolveTokenPreset(baseKey)?.displaySymbol || baseToken?.displaySymbol || baseSymbol;

    const candidatePairs = keyedPairs.filter((pair) => {
      const token0 = normalizeSymbol(pair.token0_symbol);
      const token1 = normalizeSymbol(pair.token1_symbol);
      return (token0 === baseUpper && token1 === quoteUpper) || (token0 === quoteUpper && token1 === baseUpper);
    });

    const hasExplicitCanonical = candidatePairs.some((pair) => pair.canonical === true);
    const routedPairs = hasExplicitCanonical
      ? candidatePairs.filter((pair) => pair.canonical === true)
      : candidatePairs;

    routedPairs.sort((a, b) => {
      const aLiquidity = n(a.reserve0_decimal) * n(a.reserve1_decimal);
      const bLiquidity = n(b.reserve0_decimal) * n(b.reserve1_decimal);
      const aCanonical = a.canonical === true ? 1 : 0;
      const bCanonical = b.canonical === true ? 1 : 0;
      if (aCanonical !== bCanonical) return bCanonical - aCanonical;
      const aScore = n(a.total_amount_in) * 1_000_000 + n(a.swaps) * 1_000 + aLiquidity;
      const bScore = n(b.total_amount_in) * 1_000_000 + n(b.swaps) * 1_000 + bLiquidity;
      return bScore - aScore;
    });

    const selectedPair = routedPairs[0] || null;
    const normalizedPool = normalizePoolAddress(selectedPair?.pool_address || '');
    const selectedPairId = selectedPair ? pairId(chainId, normalizedPool) : `${chainId}:virtual:${baseUpper.toLowerCase()}-${quoteUpper.toLowerCase()}`;
    const stats = selectedPair ? pairStatsById.get(selectedPairId) : undefined;

    let reserveBase = 0;
    let reserveQuote = 0;
    if (selectedPair) {
      const token0 = normalizeSymbol(selectedPair.token0_symbol);
      const token1 = normalizeSymbol(selectedPair.token1_symbol);
      const reserve0 = n(selectedPair.reserve0_decimal);
      const reserve1 = n(selectedPair.reserve1_decimal);
      if (token0 === baseUpper && token1 === quoteUpper) {
        reserveBase = reserve0;
        reserveQuote = reserve1;
      } else {
        reserveBase = reserve1;
        reserveQuote = reserve0;
      }
    }

    const hasPool = Boolean(selectedPair);
    const warnings: string[] = [];
    if (!hasPool) {
      warnings.push('No active pool');
    }
    if (hasPool && selectedPair?.canonical === false) {
      warnings.push('External pool');
    }
    if (baseToken && baseToken.riskFlags.length) {
      warnings.push(...baseToken.riskFlags.map((flag) => `${flag}`));
    }

    const lowLiquidity = !hasPool || reserveQuote <= liquidityFloor;
    if (lowLiquidity) warnings.push('Low liquidity');
    const baseDecimals = baseToken?.decimals ?? 18;
    const uiPrecisionPrice = precisionFromDecimals(quoteDecimals, 4);
    const uiPrecisionSize = precisionFromDecimals(baseDecimals, 4);
    const tickSize = 1 / Math.pow(10, uiPrecisionPrice);
    const stepSize = 1 / Math.pow(10, uiPrecisionSize);
    const maxTradeNotionalMusd = reserveQuote > 0 ? reserveQuote * (lowLiquidity ? 0.015 : 0.05) : 0;

    let observedLast = stats?.lastPrice ?? (reserveBase > 0 ? reserveQuote / reserveBase : null);
    let observedChange = stats?.change24h ?? null;
    const stableRailPair = stableMusdRails.has(baseUpper) && quoteUpper === MUSD_SYMBOL;
    if (stableRailPair) {
      if (observedLast !== null && Number.isFinite(observedLast) && Math.abs(observedLast - 1) > 0.02) {
        warnings.push(`Peg deviation (${observedLast.toFixed(4)})`);
      }
      observedLast = 1;
      observedChange = 0;
    }

    marketRows.push({
      id: selectedPairId,
      chainId,
      pair: `${baseSymbol}/${quoteSymbol}`,
      displayPair: `${baseDisplay}/${quoteDisplay}`,
      baseSymbol,
      quoteSymbol,
      baseDisplaySymbol: baseDisplay,
      quoteDisplaySymbol: quoteDisplay,
      poolAddress: selectedPair?.pool_address || '',
      hasPool,
      lowLiquidity,
      warnings: Array.from(new Set(warnings)),
      routeHint: stableRailPair
        ? `Stable rail via ${quoteDisplay}. Canonical peg target: 1.0000.`
        : hasPool
        ? `Best route via ${quoteDisplay}`
        : `No direct pool. Route via ${quoteDisplay} when liquidity is available.`,
      tickSize,
      stepSize,
      minOrder: lowLiquidity ? 0.01 : 0.1,
      uiPrecisionPrice,
      uiPrecisionSize,
      maxTradeNotionalMusd,
      reserveBase,
      reserveQuote,
      swaps: selectedPair ? n(selectedPair.swaps) : 0,
      volume24h: stats?.volume24h ?? (selectedPair ? n(selectedPair.total_amount_in) : 0),
      totalFeeUsd: selectedPair ? n(selectedPair.total_fee_usd) : 0,
      lastSwapAt: stats?.lastSwapAt ?? (selectedPair?.last_swap_at || null),
      last: observedLast,
      change24h: observedChange
    });
  }

  return marketRows;
}
