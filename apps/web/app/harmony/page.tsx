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

const wrappedNativeAbi = [
  {
    inputs: [],
    name: 'deposit',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  }
] as const;

const mintableErc20Abi = [
  {
    inputs: [
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' }
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const;

const stabilizerAbi = [
  {
    inputs: [
      { internalType: 'address', name: 'token', type: 'address' },
      { internalType: 'uint256', name: 'collateralAmount', type: 'uint256' },
      { internalType: 'uint256', name: 'minMusdOut', type: 'uint256' },
      { internalType: 'address', name: 'recipient', type: 'address' }
    ],
    name: 'mintWithCollateral',
    outputs: [{ internalType: 'uint256', name: 'musdOut', type: 'uint256' }],
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
  vault_address?: string;
  swap_fee_bps?: number;
  protocol_fee_bps?: number;
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
  total_fee_bps?: number;
  protocol_fee_bps?: number;
  lp_fee_bps?: number;
  protocol_fee_amount_in?: string;
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
const LOCAL_CHAIN_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === 'true';
const ENV_DEFAULT_CHAIN_ID = Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || (LOCAL_CHAIN_ENABLED ? '31337' : '97'));
const DEFAULT_CHAIN_ID = Number.isFinite(ENV_DEFAULT_CHAIN_ID) ? ENV_DEFAULT_CHAIN_ID : LOCAL_CHAIN_ENABLED ? 31337 : 97;
const DEFAULT_TOKENS: TokenItem[] = [
  { symbol: 'mUSD', name: 'Musical USD', address: 'local-musd', decimals: 18 },
  { symbol: 'WBNB', name: 'Wrapped BNB', address: 'local-wbnb', decimals: 18 }
];
const DEFAULT_NETWORKS_BASE: NetworkItem[] = [
  { chain_id: 97, chain_key: 'bnb-testnet', name: 'BNB Chain Testnet', network: 'bscTestnet', token_count: 2 },
  { chain_id: 11155111, chain_key: 'ethereum-sepolia', name: 'Ethereum Sepolia', network: 'sepolia', token_count: 2 }
];
const DEFAULT_NETWORKS: NetworkItem[] = LOCAL_CHAIN_ENABLED
  ? [{ chain_id: 31337, chain_key: 'hardhat-local', name: 'Hardhat Local', network: 'hardhat', token_count: 2 }, ...DEFAULT_NETWORKS_BASE]
  : DEFAULT_NETWORKS_BASE;

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

function toDecimal(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

function resolveSwapGasLimit(chainId: number, estimatedGas: bigint, chainGasCap: bigint): bigint {
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

export default function HarmonyPage() {
  const [chainId, setChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [tokensByChain, setTokensByChain] = useState<Record<string, TokenItem[]>>({});
  const [networks, setNetworks] = useState<NetworkItem[]>(DEFAULT_NETWORKS);
  const [tokenIn, setTokenIn] = useState<string>('WBNB');
  const [tokenOut, setTokenOut] = useState<string>('mUSD');
  const [tokenInQuery, setTokenInQuery] = useState<string>('');
  const [tokenOutQuery, setTokenOutQuery] = useState<string>('');
  const [autoWrapNative, setAutoWrapNative] = useState(true);
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
  const [nativeBalance, setNativeBalance] = useState<string>('0');
  const [wrapAmount, setWrapAmount] = useState<string>('0.1');
  const [testMintAmount, setTestMintAmount] = useState<string>('250');
  const [musdMintAmount, setMusdMintAmount] = useState<string>('100');
  const [musdMintSource, setMusdMintSource] = useState<string>('USDC');
  const [mintableByUser, setMintableByUser] = useState<Record<string, boolean>>({});
  const [fundingStatus, setFundingStatus] = useState<string>('');
  const [fundingError, setFundingError] = useState<string>('');
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

  useEffect(() => {
    if (networkOptions.some((network) => network.chain_id === chainId)) {
      return;
    }
    const fallback = networkOptions.find((network) => network.chain_id === DEFAULT_CHAIN_ID) || networkOptions[0];
    if (fallback) {
      setChainId(fallback.chain_id);
    }
  }, [chainId, networkOptions]);

  const tokenBySymbolUpper = useMemo(() => {
    const map = new Map<string, TokenItem>();
    for (const token of chainTokens) {
      map.set(token.symbol.toUpperCase(), token);
    }
    return map;
  }, [chainTokens]);

  const wrappedNativeSymbol = useMemo(() => {
    const wrapped = chainTokens.find((token) => {
      const symbol = token.symbol.toUpperCase();
      return symbol === 'WBNB' || symbol === 'WETH';
    });
    return wrapped?.symbol ?? (chainId === 97 ? 'WBNB' : 'WETH');
  }, [chainId, chainTokens]);

  const wrappedNativeToken = useMemo(() => {
    return tokenBySymbolUpper.get(wrappedNativeSymbol.toUpperCase()) || null;
  }, [tokenBySymbolUpper, wrappedNativeSymbol]);
  const filteredTokenInOptions = useMemo(() => {
    const query = tokenInQuery.trim().toUpperCase();
    if (!query) return chainTokens;
    return chainTokens.filter((token) => {
      return token.symbol.toUpperCase().includes(query) || token.name.toUpperCase().includes(query);
    });
  }, [chainTokens, tokenInQuery]);
  const filteredTokenOutOptions = useMemo(() => {
    const query = tokenOutQuery.trim().toUpperCase();
    if (!query) return chainTokens;
    return chainTokens.filter((token) => {
      return token.symbol.toUpperCase().includes(query) || token.name.toUpperCase().includes(query);
    });
  }, [chainTokens, tokenOutQuery]);

  const musdSymbol = useMemo(() => {
    const musd = chainTokens.find((token) => token.symbol.toUpperCase() === 'MUSD');
    return musd?.symbol ?? 'mUSD';
  }, [chainTokens]);

  useEffect(() => {
    const current = musdMintSource.toUpperCase();
    if (tokenBySymbolUpper.has(current)) {
      return;
    }
    if (tokenBySymbolUpper.has('USDC')) {
      setMusdMintSource('USDC');
      return;
    }
    if (tokenBySymbolUpper.has('USDT')) {
      setMusdMintSource('USDT');
    }
  }, [musdMintSource, tokenBySymbolUpper]);

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
        setNativeBalance('0');
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

      let nextNativeBalance = '0';
      try {
        const rawNative = await publicClient.getBalance({ address });
        nextNativeBalance = formatUnits(rawNative, 18);
      } catch {
        nextNativeBalance = '0';
      }

      if (active) {
        setWalletBalances(nextBalances);
        setNativeBalance(nextNativeBalance);
      }
    }

    loadWalletBalances();
    return () => {
      active = false;
    };
  }, [address, publicClient, chainTokens, balanceRefreshNonce]);

  useEffect(() => {
    let active = true;

    async function probeMintCapabilities() {
      if (!address || !publicClient) {
        setMintableByUser({});
        return;
      }

      const next: Record<string, boolean> = {};
      for (const symbol of ['USDC', 'USDT']) {
        const token = tokenBySymbolUpper.get(symbol);
        if (!token || !isAddress(token.address)) continue;
        try {
          await publicClient.simulateContract({
            account: address,
            address: token.address as Address,
            abi: mintableErc20Abi,
            functionName: 'mint',
            args: [address, 1n]
          });
          next[symbol] = true;
        } catch {
          next[symbol] = false;
        }
      }

      if (active) {
        setMintableByUser(next);
      }
    }

    probeMintCapabilities();
    return () => {
      active = false;
    };
  }, [address, publicClient, tokenBySymbolUpper]);

  function onChainChange(nextChainId: number) {
    setChainId(nextChainId);
    setTokenInQuery('');
    setTokenOutQuery('');
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
      setFundingError('');

      const amountInBase = parseUnits(amountIn, tokenInInfo.decimals);
      const minOutBase = parseUnits(clampAmountPrecision(quote.min_out, tokenOutInfo.decimals), tokenOutInfo.decimals);
      const router = routerAddress as Address;

      const tokenInBalance = walletBalances[tokenInInfo.symbol] || '0';
      const tokenInBalanceBase = parseUnits(clampAmountPrecision(tokenInBalance, tokenInInfo.decimals), tokenInInfo.decimals);
      if (tokenInBalanceBase < amountInBase) {
        const isWrappedNative = tokenInInfo.symbol.toUpperCase() === wrappedNativeSymbol.toUpperCase();
        if (isWrappedNative && autoWrapNative) {
          if (!wrappedNativeToken || !isAddress(wrappedNativeToken.address)) {
            setError(`Wrapped token ${wrappedNativeSymbol} is not configured for this chain.`);
            return;
          }
          if (tokenInInfo.decimals !== 18) {
            setError(`Auto-wrap requires 18 decimals for ${wrappedNativeSymbol}.`);
            return;
          }

          const deficitRaw = amountInBase - tokenInBalanceBase;
          const nativeRaw = await publicClient.getBalance({ address });
          if (nativeRaw < deficitRaw) {
            setError(
              `Insufficient native ${chainId === 97 ? 'tBNB' : 'gas token'} balance for auto-wrap. Required ${shortAmount(
                formatUnits(deficitRaw, 18)
              )}.`
            );
            return;
          }

          setExecutionStatus(
            `Auto-wrapping ${shortAmount(formatUnits(deficitRaw, 18))} ${chainId === 97 ? 'tBNB' : 'native'} to ${wrappedNativeSymbol}...`
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
          setBalanceRefreshNonce((value) => value + 1);
        } else if (isWrappedNative) {
          setError(
            `Insufficient ${tokenInInfo.symbol} balance. Wrap native ${
              chainId === 97 ? 'tBNB' : 'native gas token'
            } first, or enable auto-wrap.`
          );
        } else {
          setError(`Insufficient ${tokenInInfo.symbol} balance for this swap.`);
        }
        return;
      }

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
        const chainCap = block.gasLimit > 1_000_000n ? block.gasLimit - 1_000_000n : block.gasLimit;
        gasLimit = resolveSwapGasLimit(chainId, estimatedGas, chainCap);
      } catch {
        // Keep conservative chain-specific fallback to avoid node/provider overestimation.
      }

      const swapHash = await walletClient.writeContract({
        account: walletClient.account,
        address: router,
        abi: harmonyRouterAbi,
        functionName: 'swapExactTokensForTokens',
        args: [amountInBase, minOutBase, path, address, deadline],
        gas: gasLimit
      });

      setExecutionStatus(`Swap tx sent: ${swapHash}`);
      await publicClient.waitForTransactionReceipt({ hash: swapHash });

      setExecutionStatus(`Swap confirmed: ${swapHash}`);
      setBalanceRefreshNonce((value) => value + 1);
    } catch (swapError) {
      const message = swapError instanceof Error ? swapError.message : 'Swap transaction failed';
      if (message.toLowerCase().includes('gas limit too high')) {
        setError(
          'Swap gas estimate exceeded chain cap. Reduced gas limit is now enforced; request quote again and retry.'
        );
      } else {
        setError(message);
      }
    } finally {
      setExecuting(false);
    }
  }

  async function wrapNativeToWrapped() {
    setFundingError('');
    setFundingStatus('');

    if (!isConnected || !address) {
      setFundingError('Connect wallet first.');
      return;
    }
    if (walletChainId !== chainId) {
      setFundingError(`Wallet network mismatch. Switch wallet to chain ${chainId}.`);
      return;
    }
    if (!publicClient || !walletClient) {
      setFundingError('Wallet client is not ready.');
      return;
    }
    if (!wrappedNativeToken || !isAddress(wrappedNativeToken.address)) {
      setFundingError(`Wrapped native token (${wrappedNativeSymbol}) is not configured on this chain.`);
      return;
    }
    if (!wrapAmount || Number(wrapAmount) <= 0) {
      setFundingError('Wrap amount must be greater than zero.');
      return;
    }
    if (toDecimal(nativeBalance) < toDecimal(wrapAmount)) {
      setFundingError(`Insufficient native balance. Available: ${shortAmount(nativeBalance)}.`);
      return;
    }

    try {
      const value = parseUnits(wrapAmount, 18);
      setFundingStatus(`Wrapping ${wrapAmount} ${chainId === 97 ? 'tBNB' : 'native'} to ${wrappedNativeSymbol}...`);
      const txHash = await walletClient.writeContract({
        account: walletClient.account,
        address: wrappedNativeToken.address as Address,
        abi: wrappedNativeAbi,
        functionName: 'deposit',
        args: [],
        value,
        gas: 180_000n
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      setFundingStatus(`Wrap confirmed: ${txHash}`);
      setBalanceRefreshNonce((valueNonce) => valueNonce + 1);
      if (tokenIn.toUpperCase() !== wrappedNativeSymbol.toUpperCase()) {
        setTokenIn(wrappedNativeSymbol);
      }
    } catch (wrapError) {
      setFundingError(wrapError instanceof Error ? wrapError.message : 'wrap transaction failed');
    }
  }

  async function mintTestToken(symbol: 'USDC' | 'USDT') {
    setFundingError('');
    setFundingStatus('');

    if (!isConnected || !address) {
      setFundingError('Connect wallet first.');
      return;
    }
    if (walletChainId !== chainId) {
      setFundingError(`Wallet network mismatch. Switch wallet to chain ${chainId}.`);
      return;
    }
    if (!publicClient || !walletClient) {
      setFundingError('Wallet client is not ready.');
      return;
    }
    if (mintableByUser[symbol] === false) {
      setFundingError(
        `${symbol} mint is permissioned on this deployment. Use faucet funding or operator seed for ${symbol}.`
      );
      return;
    }

    const token = tokenBySymbolUpper.get(symbol);
    if (!token || !isAddress(token.address)) {
      setFundingError(`${symbol} is not available as an EVM token on this chain.`);
      return;
    }
    if (!testMintAmount || Number(testMintAmount) <= 0) {
      setFundingError('Test mint amount must be greater than zero.');
      return;
    }

    try {
      const amountRaw = parseUnits(testMintAmount, token.decimals);
      setFundingStatus(`Minting ${testMintAmount} ${symbol} to your wallet...`);
      const txHash = await walletClient.writeContract({
        account: walletClient.account,
        address: token.address as Address,
        abi: mintableErc20Abi,
        functionName: 'mint',
        args: [address, amountRaw],
        gas: 350_000n
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      setFundingStatus(`Mint confirmed: ${txHash}`);
      setBalanceRefreshNonce((valueNonce) => valueNonce + 1);
      setTokenIn(symbol);
      setTokenOut(musdSymbol);
      setAmountIn(testMintAmount);
      setQuote(null);
    } catch (mintError) {
      setFundingError(
        mintError instanceof Error
          ? `${symbol} mint failed (token may be non-mintable on this network): ${mintError.message}`
          : `${symbol} mint failed`
      );
    }
  }

  async function mintMusdWithCollateral() {
    setFundingError('');
    setFundingStatus('');

    if (!isConnected || !address) {
      setFundingError('Connect wallet first.');
      return;
    }
    if (walletChainId !== chainId) {
      setFundingError(`Wallet network mismatch. Switch wallet to chain ${chainId}.`);
      return;
    }
    if (!publicClient || !walletClient) {
      setFundingError('Wallet client is not ready.');
      return;
    }
    if (!selectedNetwork?.stabilizer_address || !isAddress(selectedNetwork.stabilizer_address)) {
      setFundingError('Stabilizer contract is not configured for this chain.');
      return;
    }
    if (!musdMintAmount || Number(musdMintAmount) <= 0) {
      setFundingError('mUSD mint amount must be greater than zero.');
      return;
    }

    const collateralSymbol = musdMintSource.toUpperCase();
    const collateralToken = tokenBySymbolUpper.get(collateralSymbol);
    if (!collateralToken || !isAddress(collateralToken.address)) {
      setFundingError(`${collateralSymbol} collateral token is not configured for this chain.`);
      return;
    }

    const currentCollateralBalance = walletBalances[collateralToken.symbol] || '0';
    if (toDecimal(currentCollateralBalance) < toDecimal(musdMintAmount)) {
      setFundingError(
        `Insufficient ${collateralToken.symbol} balance for mint. Mint test ${collateralToken.symbol} first or reduce amount.`
      );
      return;
    }

    try {
      const amountRaw = parseUnits(musdMintAmount, collateralToken.decimals);
      const stabilizer = selectedNetwork.stabilizer_address as Address;

      setFundingStatus(`Checking ${collateralToken.symbol} allowance for Stabilizer...`);
      const allowance = (await publicClient.readContract({
        address: collateralToken.address as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, stabilizer]
      })) as bigint;

      if (allowance < amountRaw) {
        setFundingStatus(`Approving ${collateralToken.symbol} to Stabilizer...`);
        const approveHash = await walletClient.writeContract({
          account: walletClient.account,
          address: collateralToken.address as Address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [stabilizer, maxUint256]
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      setFundingStatus(`Minting mUSD with ${musdMintAmount} ${collateralToken.symbol} collateral...`);
      const txHash = await walletClient.writeContract({
        account: walletClient.account,
        address: stabilizer,
        abi: stabilizerAbi,
        functionName: 'mintWithCollateral',
        args: [collateralToken.address as Address, amountRaw, 0n, address],
        gas: 1_100_000n
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      setFundingStatus(`mUSD mint confirmed: ${txHash}`);
      setBalanceRefreshNonce((valueNonce) => valueNonce + 1);
      setTokenIn(collateralToken.symbol);
      setTokenOut(musdSymbol);
      setAmountIn(musdMintAmount);
      setQuote(null);
    } catch (mintError) {
      setFundingError(
        mintError instanceof Error ? `mUSD mint failed: ${mintError.message}` : 'mUSD mint failed'
      );
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
              <div className="flex items-center justify-between text-[11px] text-slate-300">
                <span>
                  Native: {shortAmount(nativeBalance)} | {wrappedNativeSymbol}: {shortAmount(walletBalances[wrappedNativeSymbol] || '0')}
                </span>
                <button
                  type="button"
                  onClick={() => setAmountIn(shortAmount(walletBalances[tokenIn] || '0'))}
                  className="rounded border border-slateblue/60 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-slate-100"
                >
                  Max
                </button>
              </div>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Token In</span>
              <input
                type="text"
                value={tokenInQuery}
                onChange={(event) => setTokenInQuery(event.target.value)}
                placeholder="Search token..."
                className="w-full rounded-xl border border-slateblue/60 bg-slate-950/70 px-3 py-1.5 text-xs"
              />
              <select
                value={tokenIn}
                onChange={(event) => setTokenIn(event.target.value)}
                className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
              >
                {(filteredTokenInOptions.length ? filteredTokenInOptions : chainTokens).map((token) => (
                  <option key={`${token.address}-${token.symbol}`} value={token.symbol}>
                    {token.symbol} - {token.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Token Out</span>
              <input
                type="text"
                value={tokenOutQuery}
                onChange={(event) => setTokenOutQuery(event.target.value)}
                placeholder="Search token..."
                className="w-full rounded-xl border border-slateblue/60 bg-slate-950/70 px-3 py-1.5 text-xs"
              />
              <select
                value={tokenOut}
                onChange={(event) => setTokenOut(event.target.value)}
                className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
              >
                {(filteredTokenOutOptions.length ? filteredTokenOutOptions : chainTokens).map((token) => (
                  <option key={`${token.address}-${token.symbol}`} value={token.symbol}>
                    {token.symbol} - {token.name}
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
          <label className="flex items-center gap-2 rounded-xl border border-cyan-300/35 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
            <input
              type="checkbox"
              checked={autoWrapNative}
              onChange={(event) => setAutoWrapNative(event.target.checked)}
              className="h-4 w-4 rounded border-cyan-300/70 bg-slate-900"
            />
            Auto-wrap native {chainId === 97 ? 'tBNB' : 'gas token'} to {wrappedNativeSymbol} if needed (wallet signs wrap +
            swap)
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
        {error && (error.includes('404') || error.includes('no on-chain liquidity route')) ? (
          <div className="mt-3 rounded-xl border border-rose-400/40 bg-rose-950/25 p-3 text-xs text-rose-100">
            <p className="font-semibold">Resource not found for this swap route (404-style failure).</p>
            <p className="mt-1">
              Bootstrap liquidity for {tokenIn}/{tokenOut}, verify chain registry addresses, then retry quote.
            </p>
          </div>
        ) : null}
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
              <span className="font-semibold text-mint">Fee split:</span>{' '}
              {quote.total_fee_bps ?? 30} bps total / {quote.lp_fee_bps ?? 25} bps LP / {quote.protocol_fee_bps ?? 5}{' '}
              bps protocol
            </p>
            <p>
              <span className="font-semibold text-mint">Estimated protocol cut:</span>{' '}
              {quote.protocol_fee_amount_in || '0'} {quote.token_in}
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
          <div className="mt-2 rounded-lg border border-slateblue/50 bg-slate-900/50 px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.14em] text-slate-300">
              Native {chainId === 97 ? 'tBNB' : 'Gas Token'}
            </p>
            <p className="font-mono text-sm text-slate-100">{shortAmount(nativeBalance)}</p>
          </div>
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

          <div className="mt-3 rounded-lg border border-cyan-300/40 bg-cyan-500/10 p-3">
            <p className="text-xs uppercase tracking-[0.14em] text-cyan-100">Fund Wallet With Native Token</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                type="number"
                min="0"
                step="any"
                value={wrapAmount}
                onChange={(event) => setWrapAmount(event.target.value)}
                className="w-28 rounded-lg border border-slateblue/70 bg-slate-950/80 px-2 py-1 text-xs"
              />
              <button
                type="button"
                onClick={wrapNativeToWrapped}
                className="rounded-lg border border-cyan-300/60 bg-cyan-500/20 px-2.5 py-1.5 text-xs font-semibold text-cyan-100"
              >
                Wrap to {wrappedNativeSymbol}
              </button>
              <button
                type="button"
                onClick={() => {
                  setTokenIn(wrappedNativeSymbol);
                  setTokenOut(musdSymbol);
                  setAmountIn(wrapAmount || '0.1');
                  setQuote(null);
                }}
                className="rounded-lg border border-brass/60 bg-brass/20 px-2.5 py-1.5 text-xs font-semibold text-amber-100"
              >
                Prepare {wrappedNativeSymbol} {'->'} {musdSymbol}
              </button>
              {tokenBySymbolUpper.has('USDC') ? (
                <button
                  type="button"
                  onClick={() => {
                    setTokenIn(wrappedNativeSymbol);
                    setTokenOut(tokenBySymbolUpper.get('USDC')?.symbol || 'USDC');
                    setAmountIn(wrapAmount || '0.1');
                    setQuote(null);
                  }}
                  className="rounded-lg border border-cyan-300/60 bg-cyan-500/20 px-2.5 py-1.5 text-xs font-semibold text-cyan-100"
                >
                  Prepare {wrappedNativeSymbol} {'->'} USDC
                </button>
              ) : null}
              {tokenBySymbolUpper.has('USDT') ? (
                <button
                  type="button"
                  onClick={() => {
                    setTokenIn(wrappedNativeSymbol);
                    setTokenOut(tokenBySymbolUpper.get('USDT')?.symbol || 'USDT');
                    setAmountIn(wrapAmount || '0.1');
                    setQuote(null);
                  }}
                  className="rounded-lg border border-emerald-300/60 bg-emerald-500/20 px-2.5 py-1.5 text-xs font-semibold text-emerald-100"
                >
                  Prepare {wrappedNativeSymbol} {'->'} USDT
                </button>
              ) : null}
            </div>
            <div className="mt-3 border-t border-cyan-200/20 pt-3">
              <p className="text-xs uppercase tracking-[0.14em] text-cyan-100">Testnet Collateral + mUSD Mint</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={testMintAmount}
                  onChange={(event) => setTestMintAmount(event.target.value)}
                  className="w-24 rounded-lg border border-slateblue/70 bg-slate-950/80 px-2 py-1 text-xs"
                />
                {tokenBySymbolUpper.has('USDC') ? (
                  <button
                    type="button"
                    onClick={() => mintTestToken('USDC')}
                    disabled={mintableByUser.USDC === false}
                    className="rounded-lg border border-cyan-300/60 bg-cyan-500/20 px-2.5 py-1.5 text-xs font-semibold text-cyan-100"
                  >
                    {mintableByUser.USDC === false ? 'USDC mint locked' : 'Mint USDC (test)'}
                  </button>
                ) : null}
                {tokenBySymbolUpper.has('USDT') ? (
                  <button
                    type="button"
                    onClick={() => mintTestToken('USDT')}
                    disabled={mintableByUser.USDT === false}
                    className="rounded-lg border border-emerald-300/60 bg-emerald-500/20 px-2.5 py-1.5 text-xs font-semibold text-emerald-100"
                  >
                    {mintableByUser.USDT === false ? 'USDT mint locked' : 'Mint USDT (test)'}
                  </button>
                ) : null}
              </div>
              {mintableByUser.USDC === false || mintableByUser.USDT === false ? (
                <p className="mt-2 text-[11px] text-slate-300">
                  This deployment uses permissioned collateral minting. Use testnet faucet or operator-funded balances.
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={musdMintAmount}
                  onChange={(event) => setMusdMintAmount(event.target.value)}
                  className="w-24 rounded-lg border border-slateblue/70 bg-slate-950/80 px-2 py-1 text-xs"
                />
                <select
                  value={musdMintSource}
                  onChange={(event) => setMusdMintSource(event.target.value)}
                  className="rounded-lg border border-slateblue/70 bg-slate-950/80 px-2 py-1 text-xs"
                >
                  {tokenBySymbolUpper.has('USDC') ? <option value="USDC">USDC</option> : null}
                  {tokenBySymbolUpper.has('USDT') ? <option value="USDT">USDT</option> : null}
                </select>
                <button
                  type="button"
                  onClick={mintMusdWithCollateral}
                  className="rounded-lg border border-brass/60 bg-brass/20 px-2.5 py-1.5 text-xs font-semibold text-amber-100"
                >
                  Mint mUSD (Stabilizer)
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-300">
                Testnet flow: mint collateral to your wallet, then mint mUSD via Stabilizer with wallet-signed txs.
              </p>
            </div>
            {fundingError ? <p className="mt-2 text-xs text-rose-300">{fundingError}</p> : null}
            {fundingStatus ? <p className="mt-2 text-xs text-cyan-100">{fundingStatus}</p> : null}
          </div>
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
          {selectedNetwork ? (
            <p className="mt-1 text-xs text-amber-50/80">
              Pool fee model: {selectedNetwork.swap_fee_bps ?? 30} bps total /{' '}
              {selectedNetwork.protocol_fee_bps ?? 5} bps protocol
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
