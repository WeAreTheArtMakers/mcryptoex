'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Address, erc20Abi, formatUnits, isAddress, maxUint256, parseUnits } from 'viem';
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { WalletPanel } from '../../components/wallet-panel';

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
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const;

type TokenItem = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  source?: string;
};

type NetworkItem = {
  chain_id: number;
  chain_key: string;
  name: string;
  network: string;
  token_count: number;
  pair_count?: number;
  router_address?: string;
  factory_address?: string;
  musd_address?: string;
  stabilizer_address?: string;
  rpc_connected?: boolean;
  latest_checked_block?: number | null;
};

type TokensResponse = {
  chains: Record<string, TokenItem[]>;
  networks?: NetworkItem[];
  registry_version?: number;
  generated_at?: string;
};

type QuoteResponse = {
  chain_id: number;
  token_in: string;
  token_out: string;
  amount_in: string;
  expected_out: string;
  min_out: string;
  slippage_bps: number;
  route: string[];
  route_depth?: string;
  liquidity_source?: string;
  engine: string;
};

type RiskAssumption = {
  endpoint: string;
  asset_symbol: string;
  category: string;
  risk_level: 'low' | 'medium' | 'high';
  bridge_provider?: string;
  last_attested_at?: string | null;
  last_checked_at?: string | null;
  statement: string;
};

type RiskAssumptionsResponse = {
  chain_id: number;
  chain_key: string;
  chain_name: string;
  assumptions: RiskAssumption[];
};

const API_BASE = process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';
const DEFAULT_TOKENS: TokenItem[] = [
  { symbol: 'mUSD', name: 'Musical USD', address: 'local-musd', decimals: 18 },
  { symbol: 'WETH', name: 'Wrapped Ether', address: 'local-weth', decimals: 18 }
];
const DEFAULT_NETWORKS: NetworkItem[] = [
  { chain_id: 31337, chain_key: 'hardhat-local', name: 'Hardhat Local', network: 'hardhat', token_count: 2 },
  { chain_id: 11155111, chain_key: 'ethereum-sepolia', name: 'Ethereum Sepolia', network: 'sepolia', token_count: 2 },
  { chain_id: 97, chain_key: 'bnb-testnet', name: 'BNB Testnet', network: 'bscTestnet', token_count: 2 }
];

function extractErrorMessage(defaultPrefix: string, status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) {
      return detail;
    }
  }
  return `${defaultPrefix}: ${status}`;
}

function shortAmount(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (parsed === 0) return '0';
  if (parsed < 0.000001) return parsed.toExponential(2);
  return parsed.toFixed(6).replace(/\.?0+$/, '');
}

export default function HarmonyPage() {
  const [chainId, setChainId] = useState<number>(31337);
  const [tokensByChain, setTokensByChain] = useState<Record<string, TokenItem[]>>({});
  const [networks, setNetworks] = useState<NetworkItem[]>(DEFAULT_NETWORKS);
  const [tokenIn, setTokenIn] = useState<string>('WETH');
  const [tokenOut, setTokenOut] = useState<string>('mUSD');
  const [amountIn, setAmountIn] = useState<string>('0.1');
  const [slippageBps, setSlippageBps] = useState<number>(50);
  const [riskAssumptions, setRiskAssumptions] = useState<RiskAssumption[]>([]);
  const [riskError, setRiskError] = useState<string>('');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [executionStatus, setExecutionStatus] = useState<string>('');
  const [executing, setExecuting] = useState(false);
  const [walletBalances, setWalletBalances] = useState<Record<string, string>>({});
  const [balanceRefreshNonce, setBalanceRefreshNonce] = useState(0);

  const { address, chainId: walletChainId, isConnected } = useAccount();
  const { chains, switchChain, isPending: isSwitching } = useSwitchChain();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });

  const chainTokens = useMemo(() => tokensByChain[String(chainId)] || DEFAULT_TOKENS, [tokensByChain, chainId]);
  const networkOptions = useMemo(() => (networks.length ? networks : DEFAULT_NETWORKS), [networks]);
  const selectedNetwork = useMemo(
    () => networkOptions.find((network) => network.chain_id === chainId),
    [networkOptions, chainId]
  );

  const tokenBySymbolUpper = useMemo(() => {
    const map = new Map<string, TokenItem>();
    for (const token of chainTokens) {
      map.set(token.symbol.toUpperCase(), token);
    }
    return map;
  }, [chainTokens]);

  const musdSymbol = useMemo(() => {
    const musd = chainTokens.find((token) => token.symbol.toUpperCase() === 'MUSD');
    return musd?.symbol ?? 'mUSD';
  }, [chainTokens]);

  useEffect(() => {
    let active = true;

    async function loadTokens() {
      try {
        const res = await fetch(`${API_BASE}/tokens`, { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`token registry unavailable (${res.status})`);
        }
        const payload = (await res.json()) as TokensResponse;
        if (!active) return;

        setTokensByChain(payload.chains || {});
        if (payload.networks?.length) {
          setNetworks(payload.networks);
        }

        const preferred = payload.chains?.[String(chainId)] || DEFAULT_TOKENS;
        const preferredMusd = preferred.find((token) => token.symbol.toUpperCase() === 'MUSD')?.symbol;
        const preferredNonMusd = preferred.find((token) => token.symbol.toUpperCase() !== 'MUSD')?.symbol;

        if (!preferred.some((x) => x.symbol === tokenIn)) {
          setTokenIn(preferredNonMusd || preferred[0]?.symbol || 'WETH');
        }
        if (!preferred.some((x) => x.symbol === tokenOut)) {
          setTokenOut(preferredMusd || preferred[1]?.symbol || preferred[0]?.symbol || 'mUSD');
        }
      } catch (fetchError) {
        if (active) {
          setError(fetchError instanceof Error ? fetchError.message : 'failed to load token registry');
        }
      }
    }

    loadTokens();
    return () => {
      active = false;
    };
  }, [chainId, tokenIn, tokenOut]);

  useEffect(() => {
    let active = true;

    async function loadRiskAssumptions() {
      try {
        const res = await fetch(`${API_BASE}/risk/assumptions?chain_id=${chainId}`, { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`risk assumptions unavailable: ${res.status}`);
        }
        const payload = (await res.json()) as RiskAssumptionsResponse;
        if (!active) return;
        setRiskAssumptions(payload.assumptions || []);
        setRiskError('');
      } catch (riskFetchError) {
        if (!active) return;
        setRiskAssumptions([]);
        setRiskError(riskFetchError instanceof Error ? riskFetchError.message : 'failed to load risk assumptions');
      }
    }

    loadRiskAssumptions();
    return () => {
      active = false;
    };
  }, [chainId]);

  useEffect(() => {
    let active = true;

    async function loadWalletBalances() {
      if (!address || !publicClient) {
        setWalletBalances({});
        return;
      }

      const nextBalances: Record<string, string> = {};
      for (const token of chainTokens) {
        if (!isAddress(token.address)) continue;

        try {
          const balance = (await publicClient.readContract({
            address: token.address as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address]
          })) as bigint;
          nextBalances[token.symbol] = formatUnits(balance, token.decimals);
        } catch {
          nextBalances[token.symbol] = '0';
        }
      }

      if (active) {
        setWalletBalances(nextBalances);
      }
    }

    loadWalletBalances();
    return () => {
      active = false;
    };
  }, [address, publicClient, chainTokens, balanceRefreshNonce]);

  function onChainChange(nextChainId: number) {
    setChainId(nextChainId);
    const nextTokens = tokensByChain[String(nextChainId)] || DEFAULT_TOKENS;
    const nextMusd = nextTokens.find((token) => token.symbol.toUpperCase() === 'MUSD')?.symbol || 'mUSD';
    const nextIn = nextTokens.find((token) => token.symbol.toUpperCase() !== 'MUSD')?.symbol || nextTokens[0]?.symbol || 'WETH';
    setTokenIn(nextIn);
    setTokenOut(nextMusd);
    setQuote(null);
    setError('');
    setExecutionStatus('');
  }

  async function requestQuote(event: FormEvent) {
    event.preventDefault();
    setQuote(null);
    setError('');
    setExecutionStatus('');

    if (!amountIn || Number(amountIn) <= 0) {
      setError('Amount in must be greater than zero.');
      return;
    }

    if (tokenIn.toUpperCase() === tokenOut.toUpperCase()) {
      setError('Token in and token out cannot be the same.');
      return;
    }

    const params = new URLSearchParams({
      chain_id: String(chainId),
      token_in: tokenIn,
      token_out: tokenOut,
      amount_in: amountIn,
      slippage_bps: String(slippageBps)
    });
    if (address) {
      params.set('wallet_address', address);
    }

    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/quote?${params.toString()}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(extractErrorMessage('quote request failed', res.status, body));
      }
      setQuote(body as QuoteResponse);
    } catch (quoteError) {
      setError(quoteError instanceof Error ? quoteError.message : 'quote request failed');
    } finally {
      setLoading(false);
    }
  }

  async function executeSwapToChain() {
    setExecutionStatus('');
    setError('');

    if (!quote) {
      setError('Request a quote first.');
      return;
    }
    if (!isConnected || !address) {
      setError('Connect wallet first.');
      return;
    }
    if (walletChainId !== chainId) {
      setError(`Wallet network mismatch. Switch wallet to chain ${chainId}.`);
      return;
    }
    if (!publicClient || !walletClient) {
      setError('Wallet client is not ready.');
      return;
    }

    const routerAddress = selectedNetwork?.router_address || '';
    if (!isAddress(routerAddress)) {
      setError('Router address is not configured for this chain.');
      return;
    }

    const routeTokens = quote.route
      .map((symbol) => tokenBySymbolUpper.get(symbol.toUpperCase()))
      .filter((token): token is TokenItem => Boolean(token));

    if (routeTokens.length !== quote.route.length) {
      setError('Quote route includes tokens missing from chain registry.');
      return;
    }

    const path: Address[] = [];
    for (const token of routeTokens) {
      if (!isAddress(token.address)) {
        setError(`Token ${token.symbol} has non-EVM address in registry. Execution disabled.`);
        return;
      }
      path.push(token.address as Address);
    }

    const tokenInInfo = routeTokens[0];
    const tokenOutInfo = routeTokens[routeTokens.length - 1];

    try {
      setExecuting(true);
      setExecutionStatus('Checking allowance...');

      const amountInBase = parseUnits(amountIn, tokenInInfo.decimals);
      const minOutBase = parseUnits(quote.min_out, tokenOutInfo.decimals);
      const router = routerAddress as Address;

      const allowance = (await publicClient.readContract({
        address: tokenInInfo.address as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, router]
      })) as bigint;

      if (allowance < amountInBase) {
        setExecutionStatus('Approving token allowance...');
        const approveHash = await walletClient.writeContract({
          account: walletClient.account,
          address: tokenInInfo.address as Address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [router, maxUint256]
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      setExecutionStatus('Submitting swap transaction...');
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1_200);
      const swapHash = await walletClient.writeContract({
        account: walletClient.account,
        address: router,
        abi: harmonyRouterAbi,
        functionName: 'swapExactTokensForTokens',
        args: [amountInBase, minOutBase, path, address, deadline]
      });

      setExecutionStatus(`Swap tx sent: ${swapHash}`);
      await publicClient.waitForTransactionReceipt({ hash: swapHash });

      setExecutionStatus(`Swap confirmed: ${swapHash}`);
      setBalanceRefreshNonce((value) => value + 1);
    } catch (swapError) {
      setError(swapError instanceof Error ? swapError.message : 'Swap transaction failed');
    } finally {
      setExecuting(false);
    }
  }

  const canPromptSwitch =
    isConnected &&
    typeof walletChainId === 'number' &&
    walletChainId !== chainId &&
    chains.some((chain) => chain.id === chainId);

  const executableRouterConfigured = Boolean(selectedNetwork?.router_address && isAddress(selectedNetwork.router_address));
  const balanceRows = chainTokens
    .filter((token) => walletBalances[token.symbol] !== undefined)
    .map((token) => ({ token, balance: walletBalances[token.symbol] || '0' }));
  const sellableRows = balanceRows.filter(
    (row) => Number(row.balance) > 0 && row.token.symbol.toUpperCase() !== 'MUSD'
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
      <section className="rounded-2xl border border-slateblue/70 bg-slate-900/55 p-6 shadow-halo">
        <p className="text-xs uppercase tracking-[0.24em] text-brass">Harmony Engine</p>
        <h2 className="mt-2 text-2xl font-semibold">Swap to mUSD (Wallet-Signed)</h2>
        <p className="mt-2 text-sm text-slate-200">
          Quotes are registry-aware and liquidity-aware. Execution is non-custodial and signed in your wallet.
        </p>

        <form onSubmit={requestQuote} className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Chain</span>
              <select
                value={chainId}
                onChange={(event) => onChainChange(Number(event.target.value))}
                className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
              >
                {networkOptions.map((network) => (
                  <option key={network.chain_id} value={network.chain_id}>
                    {network.name} ({network.chain_id})
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Amount In</span>
              <input
                type="number"
                min="0"
                step="any"
                value={amountIn}
                onChange={(event) => setAmountIn(event.target.value)}
                className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Token In</span>
              <select
                value={tokenIn}
                onChange={(event) => setTokenIn(event.target.value)}
                className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
              >
                {chainTokens.map((token) => (
                  <option key={`${token.address}-${token.symbol}`} value={token.symbol}>
                    {token.symbol}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Token Out</span>
              <select
                value={tokenOut}
                onChange={(event) => setTokenOut(event.target.value)}
                className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
              >
                {chainTokens.map((token) => (
                  <option key={`${token.address}-${token.symbol}`} value={token.symbol}>
                    {token.symbol}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setTokenOut(musdSymbol)}
              className="rounded-xl border border-brass/60 bg-brass/20 px-3 py-2 text-xs font-semibold text-amber-100"
            >
              Set Output = {musdSymbol}
            </button>
          </div>

          <label className="space-y-1">
            <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Slippage (bps)</span>
            <input
              type="number"
              min={1}
              max={3000}
              value={slippageBps}
              onChange={(event) => setSlippageBps(Number(event.target.value))}
              className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={loading}
              className="rounded-xl border border-mint/60 bg-mint/20 px-4 py-2 text-sm font-semibold text-mint hover:bg-mint/30 disabled:opacity-50"
            >
              {loading ? 'Calculating...' : 'Get Quote'}
            </button>

            <button
              type="button"
              disabled={executing || !quote || !isConnected || !executableRouterConfigured}
              onClick={executeSwapToChain}
              className="rounded-xl border border-cyan-300/60 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-50"
            >
              {executing ? 'Executing swap...' : 'Execute Swap'}
            </button>

            {canPromptSwitch ? (
              <button
                type="button"
                onClick={() => switchChain({ chainId })}
                disabled={isSwitching}
                className="rounded-xl border border-brass/70 bg-brass/20 px-4 py-2 text-sm font-semibold text-amber-100 disabled:opacity-50"
              >
                {isSwitching ? 'Switching network...' : `Switch wallet to ${chainId}`}
              </button>
            ) : null}
          </div>
        </form>

        {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}
        {executionStatus ? <p className="mt-2 text-xs text-cyan-100">{executionStatus}</p> : null}

        {quote ? (
          <div className="mt-5 rounded-2xl border border-mint/50 bg-emerald-950/30 p-4 text-sm">
            <p>
              <span className="font-semibold text-mint">Expected out:</span> {quote.expected_out} {quote.token_out}
            </p>
            <p>
              <span className="font-semibold text-mint">Minimum out:</span> {quote.min_out} {quote.token_out}
            </p>
            <p>
              <span className="font-semibold text-mint">Route:</span> {quote.route.join(' -> ')}
            </p>
            <p>
              <span className="font-semibold text-mint">Liquidity:</span>{' '}
              {(quote.liquidity_source || 'n/a')}{quote.route_depth ? ` (depth ${quote.route_depth})` : ''}
            </p>
            <p>
              <span className="font-semibold text-mint">Engine:</span> {quote.engine}
            </p>
          </div>
        ) : null}
      </section>

      <div className="space-y-4">
        <WalletPanel />

        <section className="rounded-2xl border border-slateblue/70 bg-slate-950/55 p-4 text-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Wallet Token Balances</p>
          {!isConnected ? (
            <p className="mt-2 text-slate-300">Connect wallet to load balances.</p>
          ) : balanceRows.length === 0 ? (
            <p className="mt-2 text-slate-300">No readable ERC20 balances for this chain.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {balanceRows.map((row) => (
                <div key={`balance-${row.token.symbol}`} className="flex items-center justify-between rounded-lg border border-slateblue/50 bg-slate-900/50 px-3 py-2">
                  <p className="font-medium">{row.token.symbol}</p>
                  <p className="font-mono text-xs text-slate-200">{shortAmount(row.balance)}</p>
                </div>
              ))}
            </div>
          )}

          {sellableRows.length ? (
            <div className="mt-3">
              <p className="text-xs uppercase tracking-[0.16em] text-brass">Sellable to {musdSymbol}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {sellableRows.map((row) => (
                  <button
                    key={`sell-${row.token.symbol}`}
                    type="button"
                    onClick={() => {
                      setTokenIn(row.token.symbol);
                      setTokenOut(musdSymbol);
                      setAmountIn(shortAmount(row.balance));
                      setQuote(null);
                    }}
                    className="rounded-lg border border-brass/60 bg-brass/20 px-2.5 py-1.5 text-xs font-semibold text-amber-100"
                  >
                    {row.token.symbol} {'->'} {musdSymbol}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl border border-amber-400/35 bg-amber-500/10 p-4 text-sm text-amber-100">
          <p className="text-xs uppercase tracking-[0.22em] text-amber-300">Dissonance Guards</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Set strict slippage before execution.</li>
            <li>Quotes use chain-aware liquidity depth cache and can change before signing.</li>
            <li>If wallet chain mismatches, switch network before submit.</li>
            <li>Execution requires valid router/token EVM addresses in chain registry.</li>
          </ul>
          {selectedNetwork ? (
            <p className="mt-2 text-xs text-amber-50/80">
              Registry health: {selectedNetwork.rpc_connected ? 'rpc-connected' : 'rpc-disconnected'} / block{' '}
              {selectedNetwork.latest_checked_block ?? 'n/a'}
            </p>
          ) : null}
          {riskError ? <p className="mt-2 text-xs text-rose-200">{riskError}</p> : null}
          {riskAssumptions.length ? (
            <div className="mt-3 space-y-2 text-xs text-amber-100/95">
              {riskAssumptions.map((assumption) => (
                <div
                  key={`${assumption.endpoint}-${assumption.asset_symbol}`}
                  className="rounded-lg border border-amber-300/30 bg-amber-950/20 p-2"
                >
                  <p>
                    <span className="font-semibold">{assumption.asset_symbol}</span>{' '}
                    <span className="uppercase tracking-[0.12em]">[{assumption.risk_level}]</span>{' '}
                    <span className="font-mono text-[10px] opacity-80">{assumption.endpoint}</span>
                  </p>
                  <p className="mt-1 opacity-90">{assumption.statement}</p>
                  <p className="mt-1 opacity-80">
                    Provider: {assumption.bridge_provider || 'n/a'} | Last attestation:{' '}
                    {assumption.last_attested_at || 'n/a'} | Last check: {assumption.last_checked_at || 'n/a'}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
