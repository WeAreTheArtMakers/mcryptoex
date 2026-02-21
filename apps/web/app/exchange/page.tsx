'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import {
  Address,
  erc20Abi,
  formatUnits,
  isAddress,
  maxUint256,
  parseUnits
} from 'viem';
import {
  useAccount,
  usePublicClient,
  useSwitchChain,
  useWalletClient
} from 'wagmi';
import { WalletPanel } from '../../components/wallet-panel';

const API_BASE =
  process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';
const LOCAL_CHAIN_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === 'true';
const ENV_DEFAULT_CHAIN_ID = Number(
  process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID ||
    (LOCAL_CHAIN_ENABLED ? '31337' : '97')
);
const DEFAULT_CHAIN_ID = Number.isFinite(ENV_DEFAULT_CHAIN_ID)
  ? ENV_DEFAULT_CHAIN_ID
  : LOCAL_CHAIN_ENABLED
  ? 31337
  : 97;

const harmonyRouterAbi = [
  {
    inputs: [
      { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
      { internalType: 'uint256', name: 'amountOutMin', type: 'uint256' },
      { internalType: 'address[]', name: 'path', type: 'address[]' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'deadline', type: 'uint256' }
    ],
    name: 'swapExactTokensForTokens',
    outputs: [
      { internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }
    ],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const;

const wrappedNativeAbi = [
  {
    inputs: [],
    name: 'deposit',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  }
] as const;

type TokenItem = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
};

type NetworkItem = {
  chain_id: number;
  chain_key: string;
  name: string;
  router_address?: string;
  swap_fee_bps?: number;
  protocol_fee_bps?: number;
  pair_count?: number;
};

type TokensResponse = {
  chains: Record<string, TokenItem[]>;
  networks?: NetworkItem[];
};

type QuoteResponse = {
  chain_id: number;
  token_in: string;
  token_out: string;
  amount_in: string;
  expected_out: string;
  min_out: string;
  route: string[];
  route_depth?: string;
  total_fee_bps?: number;
  protocol_fee_bps?: number;
  lp_fee_bps?: number;
  protocol_fee_amount_in?: string;
};

type AnalyticsRow = {
  bucket: string;
  chain_id: number | string;
  volume?: string;
  revenue_usd?: string;
};

type AnalyticsResponse = {
  volume_by_chain_token: AnalyticsRow[];
  fee_revenue: AnalyticsRow[];
};

type PairRow = {
  chain_id: number;
  pool_address: string;
  token0_symbol: string;
  token1_symbol: string;
  reserve0_decimal: string;
  reserve1_decimal: string;
  swaps: number;
  total_fee_usd: string;
  total_amount_in: string;
  last_swap_at?: string | null;
  source?: string;
};

type PairsResponse = {
  rows: PairRow[];
};

type ChartPoint = {
  bucket: string;
  label: string;
  volume: number;
  fees: number;
};

type PairChartPoint = {
  label: string;
  volume: number;
  fees: number;
};

type PoolLiquidityPoint = {
  symbol: string;
  liquidity: number;
};

type LimitOrderDraft = {
  id: string;
  chain_id: number;
  side: 'buy' | 'sell';
  token_in: string;
  token_out: string;
  amount: string;
  limit_price: string;
  created_at: string;
};

const DEFAULT_NETWORKS: NetworkItem[] = [
  { chain_id: 97, chain_key: 'bnb-testnet', name: 'BNB Testnet' },
  {
    chain_id: 11155111,
    chain_key: 'ethereum-sepolia',
    name: 'Ethereum Sepolia'
  }
];

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortAmount(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (parsed === 0) return '0';
  if (parsed < 0.000001) return parsed.toExponential(2);
  return parsed.toFixed(6).replace(/\.?0+$/, '');
}

function extractDetail(status: number, payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) {
      return detail;
    }
  }
  return `request failed: ${status}`;
}

function clampAmountPrecision(value: string, decimals: number): string {
  const [wholeRaw, fractionRaw = ''] = value.split('.');
  const whole = wholeRaw || '0';
  if (decimals <= 0) return whole;
  const fraction = fractionRaw.slice(0, decimals);
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

const DEFAULT_SWAP_GAS_BY_CHAIN: Record<number, bigint> = {
  97: 900_000n,
  11155111: 1_200_000n,
  31337: 1_200_000n
};

const SWAP_GAS_SOFT_CAP = 3_000_000n;
const SWAP_GAS_FLOOR = 250_000n;

function resolveSwapGasLimit(
  chainId: number,
  estimatedGas: bigint,
  chainGasCap: bigint
): bigint {
  const fallback = DEFAULT_SWAP_GAS_BY_CHAIN[chainId] ?? 900_000n;
  let gas = (estimatedGas * 120n) / 100n;
  if (gas > SWAP_GAS_SOFT_CAP) {
    gas = fallback;
  }
  if (gas > chainGasCap) {
    gas = chainGasCap;
  }
  if (gas < SWAP_GAS_FLOOR) {
    gas = SWAP_GAS_FLOOR;
  }
  return gas;
}

function buildPoolGraph(pools: PairRow[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const pool of pools) {
    const a = String(pool.token0_symbol || '').toUpperCase();
    const b = String(pool.token1_symbol || '').toUpperCase();
    if (!a || !b) continue;
    if (!graph.has(a)) graph.set(a, new Set<string>());
    if (!graph.has(b)) graph.set(b, new Set<string>());
    graph.get(a)!.add(b);
    graph.get(b)!.add(a);
  }
  return graph;
}

function reachableSymbols(
  graph: Map<string, Set<string>>,
  start: string
): Set<string> {
  const startUpper = start.toUpperCase();
  const seen = new Set<string>();
  const queue: string[] = [startUpper];
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const neighbors = graph.get(current);
    if (!neighbors) continue;
    for (const next of neighbors) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

export default function ExchangePage() {
  const router = useRouter();
  const [uiMode, setUiMode] = useState<'classic' | 'pro'>('classic');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if ((params.get('uiMode') || '').toLowerCase() === 'pro') {
      setUiMode('pro');
    }
  }, []);

  useEffect(() => {
    if (uiMode === 'pro') {
      router.replace('/pro');
    }
  }, [router, uiMode]);

  const [mode, setMode] = useState<'market' | 'limit' | 'transfer'>('market');
  const [chainId, setChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [networks, setNetworks] = useState<NetworkItem[]>(DEFAULT_NETWORKS);
  const [tokensByChain, setTokensByChain] = useState<
    Record<string, TokenItem[]>
  >({});
  const [tokenIn, setTokenIn] = useState<string>('WBNB');
  const [tokenOut, setTokenOut] = useState<string>('mUSD');
  const [tokenInQuery, setTokenInQuery] = useState<string>('');
  const [tokenOutQuery, setTokenOutQuery] = useState<string>('');
  const [autoWrapNative, setAutoWrapNative] = useState(true);
  const [amountIn, setAmountIn] = useState<string>('1');
  const [slippageBps, setSlippageBps] = useState<number>(50);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [marketStatus, setMarketStatus] = useState<string>('');
  const [marketError, setMarketError] = useState<string>('');

  const [limitSide, setLimitSide] = useState<'buy' | 'sell'>('sell');
  const [limitPrice, setLimitPrice] = useState<string>('1');
  const [limitAmount, setLimitAmount] = useState<string>('1');
  const [limitOrders, setLimitOrders] = useState<LimitOrderDraft[]>([]);
  const [ticketStatus, setTicketStatus] = useState<string>('');

  const [transferToken, setTransferToken] = useState<string>('mUSD');
  const [transferTo, setTransferTo] = useState<string>('');
  const [transferAmount, setTransferAmount] = useState<string>('0.1');
  const [transferring, setTransferring] = useState(false);

  const [analytics, setAnalytics] = useState<ChartPoint[]>([]);
  const [analyticsError, setAnalyticsError] = useState<string>('');
  const [pairs, setPairs] = useState<PairRow[]>([]);
  const [pairsError, setPairsError] = useState<string>('');
  const [walletBalances, setWalletBalances] = useState<Record<string, string>>(
    {}
  );
  const [nativeBalance, setNativeBalance] = useState<string>('0');
  const [balanceNonce, setBalanceNonce] = useState(0);

  const { address, chainId: walletChainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });
  const { chains, switchChain, isPending: isSwitching } = useSwitchChain();

  const chainTokens = useMemo(
    () =>
      (tokensByChain[String(chainId)] || []).filter((token) =>
        isAddress(token.address)
      ),
    [tokensByChain, chainId]
  );
  const tokenMap = useMemo(() => {
    const m = new Map<string, TokenItem>();
    for (const token of chainTokens) m.set(token.symbol.toUpperCase(), token);
    return m;
  }, [chainTokens]);
  const wrappedNativeSymbol = useMemo(() => {
    const wrapped = chainTokens.find((token) => {
      const symbol = token.symbol.toUpperCase();
      return symbol === 'WBNB' || symbol === 'WETH';
    });
    return wrapped?.symbol ?? (chainId === 97 ? 'WBNB' : 'WETH');
  }, [chainId, chainTokens]);
  const wrappedNativeToken = useMemo(
    () => tokenMap.get(wrappedNativeSymbol.toUpperCase()) || null,
    [tokenMap, wrappedNativeSymbol]
  );
  const selectedNetwork = useMemo(
    () => networks.find((network) => network.chain_id === chainId),
    [networks, chainId]
  );
  const hasAnyErc20Balance = useMemo(
    () =>
      chainTokens.some((token) => n(walletBalances[token.symbol] || '0') > 0),
    [chainTokens, walletBalances]
  );
  const limitStorageKey = `mcryptoex.limit-orders.v1.${chainId}`;
  const latestPoint = analytics.length ? analytics[analytics.length - 1] : null;
  const pairSummary = useMemo(() => {
    const filtered = pairs.filter((pair) => Number(pair.chain_id) === chainId);
    const totalFees = filtered.reduce(
      (sum, pair) => sum + n(pair.total_fee_usd),
      0
    );
    const totalSwaps = filtered.reduce((sum, pair) => sum + n(pair.swaps), 0);
    const totalNotionalIn = filtered.reduce(
      (sum, pair) => sum + n(pair.total_amount_in),
      0
    );
    return {
      totalFees,
      totalSwaps,
      totalNotionalIn,
      pools: filtered
    };
  }, [pairs, chainId]);
  const poolGraph = useMemo(
    () => buildPoolGraph(pairSummary.pools),
    [pairSummary.pools]
  );
  const tradableSymbolSet = useMemo(() => {
    const set = new Set<string>();
    for (const symbol of poolGraph.keys()) set.add(symbol);
    return set;
  }, [poolGraph]);
  const reachableOutSet = useMemo(
    () => reachableSymbols(poolGraph, tokenIn),
    [poolGraph, tokenIn]
  );
  const filteredTokenInOptions = useMemo(() => {
    const query = tokenInQuery.trim().toUpperCase();
    const base = !query
      ? chainTokens
      : chainTokens.filter((token) => {
          return (
            token.symbol.toUpperCase().includes(query) ||
            token.name.toUpperCase().includes(query)
          );
        });
    if (!tradableSymbolSet.size) return base;
    return base.filter((token) =>
      tradableSymbolSet.has(token.symbol.toUpperCase())
    );
  }, [chainTokens, tokenInQuery, tradableSymbolSet]);
  const filteredTokenOutOptions = useMemo(() => {
    const query = tokenOutQuery.trim().toUpperCase();
    const base = !query
      ? chainTokens
      : chainTokens.filter((token) => {
          return (
            token.symbol.toUpperCase().includes(query) ||
            token.name.toUpperCase().includes(query)
          );
        });
    if (!reachableOutSet.size) return base;
    return base.filter((token) => {
      const upper = token.symbol.toUpperCase();
      return reachableOutSet.has(upper) && upper !== tokenIn.toUpperCase();
    });
  }, [chainTokens, tokenOutQuery, reachableOutSet, tokenIn]);
  const pairChartData = useMemo<PairChartPoint[]>(() => {
    return pairSummary.pools.slice(0, 10).map((pair) => ({
      label: `${pair.token0_symbol}/${pair.token1_symbol}`,
      volume:
        n(pair.total_amount_in) > 0
          ? n(pair.total_amount_in)
          : n(pair.reserve0_decimal) + n(pair.reserve1_decimal),
      fees: n(pair.total_fee_usd)
    }));
  }, [pairSummary.pools]);
  const liquiditySnapshot = useMemo<PoolLiquidityPoint[]>(() => {
    return chainTokens
      .map((token) => ({
        symbol: token.symbol,
        liquidity: n(walletBalances[token.symbol] || '0')
      }))
      .filter((item) => item.liquidity > 0)
      .sort((a, b) => b.liquidity - a.liquidity)
      .slice(0, 8);
  }, [chainTokens, walletBalances]);

  useEffect(() => {
    let active = true;
    async function loadTokens() {
      try {
        const res = await fetch(`${API_BASE}/tokens`, { cache: 'no-store' });
        if (!res.ok)
          throw new Error(`token registry unavailable (${res.status})`);
        const payload = (await res.json()) as TokensResponse;
        if (!active) return;
        setTokensByChain(payload.chains || {});
        if (payload.networks?.length) setNetworks(payload.networks);
      } catch (error) {
        if (!active) return;
        setMarketError(
          error instanceof Error ? error.message : 'token registry unavailable'
        );
      }
    }
    loadTokens();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!chainTokens.length) return;
    if (
      !chainTokens.some((token) => token.symbol === tokenIn) ||
      (tradableSymbolSet.size && !tradableSymbolSet.has(tokenIn.toUpperCase()))
    ) {
      const fallback =
        chainTokens.find(
          (token) =>
            tradableSymbolSet.has(token.symbol.toUpperCase()) &&
            token.symbol.toUpperCase() !== 'MUSD'
        ) ||
        chainTokens.find((token) =>
          tradableSymbolSet.has(token.symbol.toUpperCase())
        ) ||
        chainTokens.find((token) => token.symbol.toUpperCase() !== 'MUSD') ||
        chainTokens[0];
      if (fallback) setTokenIn(fallback.symbol);
    }

    const outReachable =
      reachableOutSet.size === 0 ||
      (reachableOutSet.has(tokenOut.toUpperCase()) &&
        tokenOut.toUpperCase() !== tokenIn.toUpperCase());
    if (
      !chainTokens.some((token) => token.symbol === tokenOut) ||
      !outReachable
    ) {
      const fallback =
        chainTokens.find((token) => {
          const upper = token.symbol.toUpperCase();
          return (
            upper === 'MUSD' &&
            upper !== tokenIn.toUpperCase() &&
            (reachableOutSet.size === 0 || reachableOutSet.has(upper))
          );
        }) ||
        chainTokens.find((token) => {
          const upper = token.symbol.toUpperCase();
          return (
            upper !== tokenIn.toUpperCase() &&
            (reachableOutSet.size === 0 || reachableOutSet.has(upper))
          );
        }) ||
        chainTokens[0];
      if (fallback) setTokenOut(fallback.symbol);
    }
    if (!chainTokens.some((token) => token.symbol === transferToken)) {
      setTransferToken(chainTokens[0].symbol);
    }
  }, [
    chainTokens,
    tokenIn,
    tokenOut,
    transferToken,
    tradableSymbolSet,
    reachableOutSet
  ]);

  useEffect(() => {
    let active = true;
    async function loadAnalytics() {
      try {
        const res = await fetch(`${API_BASE}/analytics?minutes=360`, {
          cache: 'no-store'
        });
        if (!res.ok) throw new Error(`analytics unavailable (${res.status})`);
        const payload = (await res.json()) as AnalyticsResponse;
        if (!active) return;

        const map = new Map<string, ChartPoint>();
        for (const row of payload.volume_by_chain_token || []) {
          if (Number(row.chain_id) !== chainId) continue;
          const existing = map.get(row.bucket) || {
            bucket: row.bucket,
            label: new Date(row.bucket).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            }),
            volume: 0,
            fees: 0
          };
          existing.volume += n(row.volume);
          map.set(row.bucket, existing);
        }
        for (const row of payload.fee_revenue || []) {
          if (Number(row.chain_id) !== chainId) continue;
          const existing = map.get(row.bucket) || {
            bucket: row.bucket,
            label: new Date(row.bucket).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            }),
            volume: 0,
            fees: 0
          };
          existing.fees += n(row.revenue_usd);
          map.set(row.bucket, existing);
        }
        setAnalytics(
          Array.from(map.values())
            .sort((a, b) => a.bucket.localeCompare(b.bucket))
            .slice(-120)
        );
        setAnalyticsError('');
      } catch (error) {
        if (!active) return;
        setAnalyticsError(
          error instanceof Error ? error.message : 'analytics unavailable'
        );
      }
    }
    loadAnalytics();
    const interval = setInterval(loadAnalytics, 20_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [chainId]);

  useEffect(() => {
    let active = true;

    async function loadPairs() {
      try {
        const res = await fetch(
          `${API_BASE}/pairs?chain_id=${chainId}&limit=60`,
          { cache: 'no-store' }
        );
        if (!res.ok) throw new Error(`pairs unavailable (${res.status})`);
        const payload = (await res.json()) as PairsResponse;
        if (!active) return;
        setPairs(payload.rows || []);
        setPairsError('');
      } catch (error) {
        if (!active) return;
        setPairs([]);
        setPairsError(
          error instanceof Error ? error.message : 'pairs unavailable'
        );
      }
    }

    loadPairs();
    const timer = setInterval(loadPairs, 12_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [chainId]);

  useEffect(() => {
    let active = true;
    async function loadBalances() {
      if (!address || !publicClient) {
        setWalletBalances({});
        setNativeBalance('0');
        return;
      }
      const next: Record<string, string> = {};
      for (const token of chainTokens) {
        if (!isAddress(token.address)) continue;
        try {
          const raw = (await publicClient.readContract({
            address: token.address as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address]
          })) as bigint;
          next[token.symbol] = formatUnits(raw, token.decimals);
        } catch {
          next[token.symbol] = '0';
        }
      }
      try {
        const rawNative = await publicClient.getBalance({ address });
        setNativeBalance(formatUnits(rawNative, 18));
      } catch {
        setNativeBalance('0');
      }
      if (active) setWalletBalances(next);
    }
    loadBalances();
    return () => {
      active = false;
    };
  }, [address, publicClient, chainTokens, balanceNonce]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(limitStorageKey);
      if (!raw) {
        setLimitOrders([]);
        return;
      }
      const parsed = JSON.parse(raw) as LimitOrderDraft[];
      setLimitOrders(Array.isArray(parsed) ? parsed.slice(0, 20) : []);
    } catch {
      setLimitOrders([]);
    }
  }, [limitStorageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      limitStorageKey,
      JSON.stringify(limitOrders.slice(0, 20))
    );
  }, [limitStorageKey, limitOrders]);

  async function requestQuote() {
    setQuote(null);
    setMarketError('');
    setMarketStatus('');

    if (!amountIn || Number(amountIn) <= 0) {
      setMarketError('amount_in must be greater than zero');
      return;
    }
    if (tokenIn.toUpperCase() === tokenOut.toUpperCase()) {
      setMarketError('token_in and token_out cannot be the same');
      return;
    }

    try {
      setQuoteLoading(true);
      const params = new URLSearchParams({
        chain_id: String(chainId),
        token_in: tokenIn,
        token_out: tokenOut,
        amount_in: amountIn,
        slippage_bps: String(slippageBps)
      });
      if (address) params.set('wallet_address', address);
      const res = await fetch(`${API_BASE}/quote?${params.toString()}`, {
        cache: 'no-store'
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(extractDetail(res.status, body));
      }
      setQuote(body as QuoteResponse);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'quote request failed';
      if (
        message.includes('no on-chain liquidity route') &&
        pairSummary.pools.length
      ) {
        const available = pairSummary.pools
          .map((pool) => `${pool.token0_symbol}/${pool.token1_symbol}`)
          .join(', ');
        setMarketError(
          `${message}. Available pools on chain ${chainId}: ${available}`
        );
      } else {
        setMarketError(message);
      }
    } finally {
      setQuoteLoading(false);
    }
  }

  async function executeMarketSwap() {
    setMarketStatus('');
    setMarketError('');
    if (!quote) {
      setMarketError('Request quote first.');
      return;
    }
    if (!isConnected || !address) {
      setMarketError('Connect wallet first.');
      return;
    }
    if (walletChainId !== chainId) {
      setMarketError(
        `Wallet network mismatch. Switch wallet to chain ${chainId}.`
      );
      return;
    }
    if (!publicClient || !walletClient) {
      setMarketError('Wallet client not ready.');
      return;
    }
    if (
      !selectedNetwork?.router_address ||
      !isAddress(selectedNetwork.router_address)
    ) {
      setMarketError('Router address is missing in chain registry.');
      return;
    }

    const routeTokens = quote.route
      .map((symbol) => tokenMap.get(symbol.toUpperCase()))
      .filter((item): item is TokenItem => Boolean(item));
    if (routeTokens.length !== quote.route.length) {
      setMarketError('Route token mapping failed for registry symbols.');
      return;
    }
    const path: Address[] = [];
    for (const token of routeTokens) {
      if (!isAddress(token.address)) {
        setMarketError(`Token ${token.symbol} is non-EVM in registry.`);
        return;
      }
      path.push(token.address as Address);
    }

    const tokenInInfo = routeTokens[0];
    const tokenOutInfo = routeTokens[routeTokens.length - 1];
    const router = selectedNetwork.router_address as Address;

    try {
      const amountInBase = parseUnits(amountIn, tokenInInfo.decimals);
      const minOutBase = parseUnits(
        clampAmountPrecision(quote.min_out, tokenOutInfo.decimals),
        tokenOutInfo.decimals
      );
      const tokenInBalance = walletBalances[tokenInInfo.symbol] || '0';
      const tokenInBalanceBase = parseUnits(
        clampAmountPrecision(tokenInBalance, tokenInInfo.decimals),
        tokenInInfo.decimals
      );
      if (tokenInBalanceBase < amountInBase) {
        const isWrappedNative =
          tokenInInfo.symbol.toUpperCase() ===
          wrappedNativeSymbol.toUpperCase();
        if (isWrappedNative && autoWrapNative) {
          if (!wrappedNativeToken || !isAddress(wrappedNativeToken.address)) {
            setMarketError(
              `Wrapped token ${wrappedNativeSymbol} is not configured for this chain.`
            );
            return;
          }
          if (tokenInInfo.decimals !== 18) {
            setMarketError(
              `Auto-wrap requires 18 decimals for ${wrappedNativeSymbol}.`
            );
            return;
          }

          const deficitRaw = amountInBase - tokenInBalanceBase;
          const nativeRaw = await publicClient.getBalance({ address });
          if (nativeRaw < deficitRaw) {
            setMarketError(
              `Insufficient native ${
                chainId === 97 ? 'tBNB' : 'gas token'
              } balance for auto-wrap. Required ${shortAmount(
                formatUnits(deficitRaw, 18)
              )}.`
            );
            return;
          }

          setMarketStatus(
            `Auto-wrapping ${shortAmount(formatUnits(deficitRaw, 18))} ${
              chainId === 97 ? 'tBNB' : 'native'
            } to ${wrappedNativeSymbol}...`
          );
          const wrapHash = await walletClient.writeContract({
            account: walletClient.account,
            address: wrappedNativeToken.address as Address,
            abi: wrappedNativeAbi,
            functionName: 'deposit',
            args: [],
            value: deficitRaw,
            gas: 180_000n
          });
          await publicClient.waitForTransactionReceipt({ hash: wrapHash });
          setBalanceNonce((value) => value + 1);
        } else {
          setMarketError(
            `Insufficient ${tokenInInfo.symbol} balance. ${
              isWrappedNative
                ? `Hold native ${
                    chainId === 97 ? 'tBNB' : 'gas token'
                  } and enable auto-wrap, or wrap manually first.`
                : 'Fund this token before swap.'
            }`
          );
          return;
        }
      }

      setMarketStatus('Checking allowance...');
      const allowance = (await publicClient.readContract({
        address: tokenInInfo.address as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, router]
      })) as bigint;

      if (allowance < amountInBase) {
        setMarketStatus('Approving token allowance...');
        const approveHash = await walletClient.writeContract({
          account: walletClient.account,
          address: tokenInInfo.address as Address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [router, maxUint256]
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      setMarketStatus('Submitting swap transaction...');
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1_200);
      let gasLimit = DEFAULT_SWAP_GAS_BY_CHAIN[chainId] ?? 900_000n;
      try {
        const [estimatedGas, block] = await Promise.all([
          publicClient.estimateContractGas({
            account: address,
            address: router,
            abi: harmonyRouterAbi,
            functionName: 'swapExactTokensForTokens',
            args: [amountInBase, minOutBase, path, address, deadline]
          }),
          publicClient.getBlock({ blockTag: 'latest' })
        ]);
        const chainCap =
          block.gasLimit > 1_000_000n
            ? block.gasLimit - 1_000_000n
            : block.gasLimit;
        gasLimit = resolveSwapGasLimit(chainId, estimatedGas, chainCap);
      } catch {
        // Keep conservative chain-specific fallback to avoid provider overestimation.
      }

      const swapHash = await walletClient.writeContract({
        account: walletClient.account,
        address: router,
        abi: harmonyRouterAbi,
        functionName: 'swapExactTokensForTokens',
        args: [amountInBase, minOutBase, path, address, deadline],
        gas: gasLimit
      });
      setMarketStatus(`Swap tx sent: ${swapHash}`);
      await publicClient.waitForTransactionReceipt({ hash: swapHash });
      setMarketStatus(`Swap confirmed: ${swapHash}`);
      setBalanceNonce((value) => value + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Swap failed';
      if (message.toLowerCase().includes('gas limit too high')) {
        setMarketError(
          'Swap gas estimate exceeded chain cap. Request a fresh quote and retry.'
        );
      } else {
        setMarketError(message);
      }
    }
  }

  function queueLimitDraft() {
    setTicketStatus('');
    if (Number(limitPrice) <= 0 || Number(limitAmount) <= 0) {
      setTicketStatus('Limit price and amount must be greater than zero.');
      return;
    }
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const next: LimitOrderDraft = {
      id,
      chain_id: chainId,
      side: limitSide,
      token_in: tokenIn,
      token_out: tokenOut,
      amount: limitAmount,
      limit_price: limitPrice,
      created_at: new Date().toISOString()
    };
    setLimitOrders((orders) => [next, ...orders].slice(0, 20));
    setTicketStatus(
      'Limit order draft queued locally. Execution movement is next.'
    );
  }

  async function executeTransfer() {
    setTicketStatus('');
    if (!isConnected || !address) {
      setTicketStatus('Connect wallet before transfer.');
      return;
    }
    if (walletChainId !== chainId) {
      setTicketStatus(
        `Wallet network mismatch. Switch wallet to chain ${chainId}.`
      );
      return;
    }
    if (!publicClient || !walletClient) {
      setTicketStatus('Wallet client not ready.');
      return;
    }
    if (!isAddress(transferTo)) {
      setTicketStatus('Recipient address is invalid.');
      return;
    }
    if (!transferAmount || Number(transferAmount) <= 0) {
      setTicketStatus('Transfer amount must be greater than zero.');
      return;
    }
    const token = tokenMap.get(transferToken.toUpperCase());
    if (!token || !isAddress(token.address)) {
      setTicketStatus('Token not transferable on this chain.');
      return;
    }

    try {
      setTransferring(true);
      const amountRaw = parseUnits(transferAmount, token.decimals);
      const txHash = await walletClient.writeContract({
        account: walletClient.account,
        address: token.address as Address,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [transferTo as Address, amountRaw]
      });
      setTicketStatus(`Transfer submitted: ${txHash}`);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      setTicketStatus(`Transfer confirmed: ${txHash}`);
      setBalanceNonce((value) => value + 1);
    } catch (error) {
      setTicketStatus(
        error instanceof Error ? error.message : 'Token transfer failed'
      );
    } finally {
      setTransferring(false);
    }
  }

  const canPromptSwitch =
    isConnected &&
    typeof walletChainId === 'number' &&
    walletChainId !== chainId &&
    chains.some((chain) => chain.id === chainId);

  if (uiMode === 'pro') {
    return (
      <div className="flex min-h-[60vh] items-center justify-center rounded-2xl border border-slateblue/60 bg-slate-950/50 text-sm text-slate-300">
        Redirecting to Exchange Pro…
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
      <section className="space-y-4 rounded-3xl border border-slateblue/70 bg-gradient-to-br from-[#101e39]/95 via-[#102241]/90 to-[#17335a]/80 p-5 shadow-halo">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-brass">
              Exchange Movement
            </p>
            <h2 className="text-2xl font-semibold">
              Market / Limit / Transfer Desk
            </h2>
          </div>
          <div className="rounded-xl border border-slateblue/70 bg-slate-950/60 px-3 py-2 text-xs text-slate-200">
            Chain {chainId} | Pools {selectedNetwork?.pair_count ?? 'n/a'}
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-mint/45 bg-mint/10 p-3">
            <p className="text-[11px] uppercase tracking-[0.14em] text-mint">
              Volume (1m latest)
            </p>
            <p className="mt-1 font-mono">
              {latestPoint
                ? latestPoint.volume.toFixed(4)
                : pairSummary.totalNotionalIn.toFixed(4)}
            </p>
          </div>
          <div className="rounded-xl border border-brass/45 bg-brass/10 p-3">
            <p className="text-[11px] uppercase tracking-[0.14em] text-amber-100">
              Fees USD (1m latest)
            </p>
            <p className="mt-1 font-mono">
              {latestPoint
                ? latestPoint.fees.toFixed(4)
                : pairSummary.totalFees.toFixed(4)}
            </p>
          </div>
          <div className="rounded-xl border border-cyan-300/40 bg-cyan-500/10 p-3">
            <p className="text-[11px] uppercase tracking-[0.14em] text-cyan-100">
              Route Target
            </p>
            <p className="mt-1 font-mono">
              {tokenIn} -&gt; {tokenOut}
            </p>
          </div>
        </div>

        <div className="h-64 rounded-2xl border border-slateblue/65 bg-[#081223]/75 p-2">
          {analytics.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={analytics}>
                <defs>
                  <linearGradient
                    id="chartVolumeFill"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#34d399" stopOpacity={0.45} />
                    <stop offset="95%" stopColor="#34d399" stopOpacity={0.04} />
                  </linearGradient>
                  <linearGradient
                    id="chartFeesFill"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#334155"
                  opacity={0.45}
                />
                <XAxis
                  dataKey="label"
                  stroke="#cbd5e1"
                  tick={{ fontSize: 11 }}
                  minTickGap={20}
                />
                <YAxis
                  yAxisId="left"
                  stroke="#86efac"
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="#fcd34d"
                  tick={{ fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    background: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '0.75rem'
                  }}
                  labelStyle={{ color: '#f8fafc' }}
                  formatter={(value, name) => [
                    n(value).toFixed(6),
                    String(name)
                  ]}
                />
                <Area
                  yAxisId="left"
                  type="monotone"
                  dataKey="volume"
                  stroke="#34d399"
                  fill="url(#chartVolumeFill)"
                  strokeWidth={2}
                />
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="fees"
                  stroke="#f59e0b"
                  fill="url(#chartFeesFill)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : pairChartData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={pairChartData}
                margin={{ top: 8, right: 8, left: 0, bottom: 28 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#334155"
                  opacity={0.4}
                />
                <XAxis
                  dataKey="label"
                  stroke="#cbd5e1"
                  angle={-16}
                  textAnchor="end"
                  height={44}
                  tick={{ fontSize: 10 }}
                />
                <YAxis
                  yAxisId="left"
                  stroke="#34d399"
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="#f59e0b"
                  tick={{ fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    background: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '0.75rem'
                  }}
                  formatter={(value, name) => [
                    n(value).toFixed(6),
                    String(name)
                  ]}
                />
                <Bar
                  yAxisId="left"
                  dataKey="volume"
                  fill="#34d399"
                  radius={[6, 6, 0, 0]}
                />
                <Bar
                  yAxisId="right"
                  dataKey="fees"
                  fill="#f59e0b"
                  radius={[6, 6, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-sm text-slate-300">
              <p>Waiting for analytics stream...</p>
              <p className="mt-1 text-xs text-slate-400">
                Live pools: {pairSummary.pools.length} | Total swaps:{' '}
                {pairSummary.totalSwaps}
              </p>
            </div>
          )}
        </div>
        {analyticsError ? (
          <p className="text-xs text-rose-300">{analyticsError}</p>
        ) : null}
        {pairsError ? (
          <p className="text-xs text-rose-300">{pairsError}</p>
        ) : null}

        <div className="rounded-2xl border border-slateblue/65 bg-slate-950/55 p-4">
          <div className="grid grid-cols-3 gap-2">
            {(['market', 'limit', 'transfer'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setMode(tab)}
                className={`rounded-lg border px-2 py-2 text-xs font-semibold uppercase tracking-[0.12em] ${
                  mode === tab
                    ? 'border-mint/70 bg-mint/20 text-mint'
                    : 'border-slateblue/65 bg-slate-900/55 text-slate-200 hover:border-slateblue'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          {mode === 'market' ? (
            <div className="mt-3 space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.14em] text-slate-300">
                    Chain
                  </span>
                  <select
                    value={chainId}
                    onChange={(event) => {
                      setChainId(Number(event.target.value));
                      setTokenInQuery('');
                      setTokenOutQuery('');
                      setQuote(null);
                    }}
                    className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                  >
                    {networks.map((network) => (
                      <option key={network.chain_id} value={network.chain_id}>
                        {network.name} ({network.chain_id})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.14em] text-slate-300">
                    Amount
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amountIn}
                    onChange={(event) => setAmountIn(event.target.value)}
                    className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                  />
                  <div className="flex items-center justify-between text-[11px] text-slate-300">
                    <span>
                      Native: {shortAmount(nativeBalance)} |{' '}
                      {wrappedNativeSymbol}:{' '}
                      {shortAmount(walletBalances[wrappedNativeSymbol] || '0')}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setAmountIn(shortAmount(walletBalances[tokenIn] || '0'))
                      }
                      className="rounded border border-slateblue/60 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-slate-100"
                    >
                      Max
                    </button>
                  </div>
                </label>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.14em] text-slate-300">
                    Token In
                  </span>
                  <input
                    type="text"
                    value={tokenInQuery}
                    onChange={(event) => setTokenInQuery(event.target.value)}
                    placeholder="Search token..."
                    className="w-full rounded-lg border border-slateblue/50 bg-slate-950/65 px-3 py-1.5 text-xs"
                  />
                  <select
                    value={tokenIn}
                    onChange={(event) => setTokenIn(event.target.value)}
                    className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                  >
                    {(filteredTokenInOptions.length
                      ? filteredTokenInOptions
                      : chainTokens
                    ).map((token) => (
                      <option
                        key={`in-${token.address}-${token.symbol}`}
                        value={token.symbol}
                      >
                        {token.symbol} - {token.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.14em] text-slate-300">
                    Token Out
                  </span>
                  <input
                    type="text"
                    value={tokenOutQuery}
                    onChange={(event) => setTokenOutQuery(event.target.value)}
                    placeholder="Search token..."
                    className="w-full rounded-lg border border-slateblue/50 bg-slate-950/65 px-3 py-1.5 text-xs"
                  />
                  <select
                    value={tokenOut}
                    onChange={(event) => setTokenOut(event.target.value)}
                    className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                  >
                    {(filteredTokenOutOptions.length
                      ? filteredTokenOutOptions
                      : chainTokens
                    ).map((token) => (
                      <option
                        key={`out-${token.address}-${token.symbol}`}
                        value={token.symbol}
                      >
                        {token.symbol} - {token.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.14em] text-slate-300">
                  Slippage (bps)
                </span>
                <input
                  type="number"
                  min={1}
                  max={3000}
                  value={slippageBps}
                  onChange={(event) =>
                    setSlippageBps(Number(event.target.value))
                  }
                  className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                />
              </label>
              <label className="flex items-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
                <input
                  type="checkbox"
                  checked={autoWrapNative}
                  onChange={(event) => setAutoWrapNative(event.target.checked)}
                  className="h-4 w-4 rounded border-cyan-300/70 bg-slate-900"
                />
                Auto-wrap native {chainId === 97 ? 'tBNB' : 'gas token'} to{' '}
                {wrappedNativeSymbol} if needed (wallet signs wrap + swap)
              </label>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={requestQuote}
                  disabled={quoteLoading}
                  className="rounded-lg border border-mint/65 bg-mint/20 px-4 py-2 text-sm font-semibold text-mint disabled:opacity-50"
                >
                  {quoteLoading ? 'Quoting...' : 'Get Market Quote'}
                </button>
                <button
                  type="button"
                  onClick={executeMarketSwap}
                  disabled={!quote || !isConnected}
                  className="rounded-lg border border-cyan-300/60 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-50"
                >
                  Execute Market Swap
                </button>
                <a
                  href="/liquidity"
                  className="rounded-lg border border-brass/65 bg-brass/20 px-4 py-2 text-sm font-semibold text-amber-100"
                >
                  Deposit (LP)
                </a>
                {canPromptSwitch ? (
                  <button
                    type="button"
                    onClick={() => switchChain({ chainId })}
                    disabled={isSwitching}
                    className="rounded-lg border border-brass/70 bg-brass/20 px-4 py-2 text-sm font-semibold text-amber-100 disabled:opacity-50"
                  >
                    {isSwitching
                      ? 'Switching...'
                      : `Switch Wallet to ${chainId}`}
                  </button>
                ) : null}
              </div>

              {marketError ? (
                <p className="text-sm text-rose-300">{marketError}</p>
              ) : null}
              {marketStatus ? (
                <p className="text-xs text-cyan-100">{marketStatus}</p>
              ) : null}
              {quote ? (
                <div className="rounded-lg border border-mint/50 bg-emerald-950/25 p-3 text-sm">
                  <p>
                    Expected out: {quote.expected_out} {quote.token_out}
                  </p>
                  <p>
                    Minimum out: {quote.min_out} {quote.token_out}
                  </p>
                  <p>Route: {quote.route.join(' -&gt; ')}</p>
                  <p>Depth: {quote.route_depth || 'n/a'}</p>
                  <p>
                    Fee split: {quote.total_fee_bps ?? 30} bps total /{' '}
                    {quote.lp_fee_bps ?? 25} bps LP /{' '}
                    {quote.protocol_fee_bps ?? 5} bps protocol
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {mode === 'limit' ? (
            <div className="mt-3 space-y-2">
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.14em] text-slate-300">
                    Side
                  </span>
                  <select
                    value={limitSide}
                    onChange={(event) =>
                      setLimitSide(event.target.value as 'buy' | 'sell')
                    }
                    className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                  >
                    <option value="buy">Buy</option>
                    <option value="sell">Sell</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.14em] text-slate-300">
                    Limit Price
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={limitPrice}
                    onChange={(event) => setLimitPrice(event.target.value)}
                    className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.14em] text-slate-300">
                    Amount
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={limitAmount}
                    onChange={(event) => setLimitAmount(event.target.value)}
                    className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={queueLimitDraft}
                className="rounded-lg border border-brass/70 bg-brass/20 px-4 py-2 text-sm font-semibold text-amber-100"
              >
                Queue Limit Draft
              </button>
              <p className="text-xs text-slate-300">
                Drafts are local in this movement. On-chain limit order module
                is the next movement.
              </p>
            </div>
          ) : null}

          {mode === 'transfer' ? (
            <div className="mt-3 space-y-2">
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.14em] text-slate-300">
                  Token
                </span>
                <select
                  value={transferToken}
                  onChange={(event) => setTransferToken(event.target.value)}
                  className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                >
                  {chainTokens.map((token) => (
                    <option
                      key={`transfer-${token.address}-${token.symbol}`}
                      value={token.symbol}
                    >
                      {token.symbol}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.14em] text-slate-300">
                  Recipient
                </span>
                <input
                  type="text"
                  value={transferTo}
                  onChange={(event) => setTransferTo(event.target.value)}
                  placeholder="0x..."
                  className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.14em] text-slate-300">
                  Amount
                </span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={transferAmount}
                  onChange={(event) => setTransferAmount(event.target.value)}
                  className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                />
              </label>
              <button
                type="button"
                onClick={executeTransfer}
                disabled={transferring}
                className="rounded-lg border border-cyan-300/60 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-50"
              >
                {transferring ? 'Transferring...' : 'Transfer Token'}
              </button>
            </div>
          ) : null}
          {ticketStatus ? (
            <p className="mt-2 text-xs text-cyan-100">{ticketStatus}</p>
          ) : null}
        </div>
      </section>

      <div className="space-y-4">
        <WalletPanel />

        <section className="rounded-2xl border border-slateblue/70 bg-slate-950/55 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-300">
            Wallet Balances
          </p>
          <div className="mt-2 rounded-lg border border-slateblue/50 bg-slate-900/50 px-3 py-2 text-sm">
            <p className="text-[11px] uppercase tracking-[0.14em] text-slate-300">
              Native {chainId === 97 ? 'tBNB' : 'Gas Token'}
            </p>
            <p className="font-mono text-xs">{shortAmount(nativeBalance)}</p>
          </div>
          {!isConnected ? (
            <p className="mt-2 text-sm text-slate-300">
              Connect wallet to load balances.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {chainTokens.map((token) => (
                <div
                  key={`bal-${token.address}-${token.symbol}`}
                  className="flex items-center justify-between rounded-lg border border-slateblue/50 bg-slate-900/50 px-3 py-2 text-sm"
                >
                  <p>{token.symbol}</p>
                  <p className="font-mono text-xs">
                    {shortAmount(walletBalances[token.symbol] || '0')}
                  </p>
                </div>
              ))}
            </div>
          )}
          {isConnected && !hasAnyErc20Balance ? (
            <div className="mt-2 rounded-lg border border-cyan-300/35 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
              ERC20 balances are empty. Use{' '}
              <a href="/harmony" className="underline">
                Harmony funding tools
              </a>{' '}
              to wrap native {chainId === 97 ? 'tBNB' : 'gas token'}, mint test
              collateral, and mint mUSD.
            </div>
          ) : null}
          {liquiditySnapshot.length ? (
            <div className="mt-3 h-36 rounded-lg border border-slateblue/55 bg-slate-900/50 p-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={liquiditySnapshot}
                  margin={{ top: 6, right: 6, left: 0, bottom: 20 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#334155"
                    opacity={0.35}
                  />
                  <XAxis
                    dataKey="symbol"
                    stroke="#cbd5e1"
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis stroke="#34d399" tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: '0.75rem'
                    }}
                    formatter={(value) => [
                      n(value).toFixed(6),
                      'wallet_balance'
                    ]}
                  />
                  <Bar
                    dataKey="liquidity"
                    fill="#34d399"
                    radius={[6, 6, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl border border-brass/45 bg-brass/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-brass">
            Local Limit Board
          </p>
          {limitOrders.length ? (
            <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
              {limitOrders.map((order) => (
                <div
                  key={order.id}
                  className="rounded-lg border border-slateblue/55 bg-slate-900/60 p-2 text-xs text-slate-200"
                >
                  <p>
                    {order.side.toUpperCase()} {order.amount} {order.token_in} @{' '}
                    {order.limit_price}
                  </p>
                  <p className="opacity-70">
                    {new Date(order.created_at).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-slate-300">
              No local limit drafts yet.
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-cyan-300/35 bg-cyan-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-100">
            Live Pools
          </p>
          {pairSummary.pools.length ? (
            <div className="mt-2 max-h-52 space-y-2 overflow-y-auto">
              {pairSummary.pools.map((pair) => (
                <div
                  key={`${pair.chain_id}-${pair.pool_address}`}
                  className="rounded-lg border border-slateblue/55 bg-slate-900/60 p-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <p className="font-semibold">
                      {pair.token0_symbol}/{pair.token1_symbol}
                    </p>
                    <p className="font-mono text-slate-300">
                      {shortAmount(String(pair.total_fee_usd))} USD fee
                    </p>
                  </div>
                  <p className="mt-1 text-slate-300">
                    Reserves: {shortAmount(String(pair.reserve0_decimal))}{' '}
                    {pair.token0_symbol} /{' '}
                    {shortAmount(String(pair.reserve1_decimal))}{' '}
                    {pair.token1_symbol}
                  </p>
                  <p className="text-slate-400">
                    Swaps: {pair.swaps} | Last swap:{' '}
                    {pair.last_swap_at
                      ? new Date(pair.last_swap_at).toLocaleTimeString()
                      : 'n/a'}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-slate-300">
              No on-chain pools discovered for this chain yet.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
