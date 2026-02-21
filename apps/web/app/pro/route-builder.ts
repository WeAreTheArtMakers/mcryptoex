export type QuoteEngineQuote = {
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
  engine?: string;
};

export type RoutePlan = QuoteEngineQuote & {
  plan: 'direct' | 'via-musd';
  note: string;
  legs: QuoteEngineQuote[];
};

export type QuoteFetcher = (params: {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippageBps: number;
  walletAddress?: string;
}) => Promise<QuoteEngineQuote>;

type BuildRoutePlanParams = {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippageBps: number;
  musdSymbol: string;
  requireMusdQuote: boolean;
  walletAddress?: string;
  fetchQuote: QuoteFetcher;
};

function normalizeSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase();
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeBps(hops: Array<number | undefined>): number {
  const normalized = hops
    .map((item) => Math.max(0, num(item)))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((bps) => Math.min(10_000, bps));
  if (!normalized.length) return 0;

  let keep = 1;
  for (const bps of normalized) {
    keep *= 1 - bps / 10_000;
  }
  return Math.round((1 - keep) * 10_000);
}

function buildViaMusdNote(route: string[]): string {
  if (route.length < 3) return 'Route is direct on-chain.';
  return 'You will first convert to mUSD (internal), then execute the trade.';
}

export async function buildRoutePlan(params: BuildRoutePlanParams): Promise<RoutePlan> {
  const {
    chainId,
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    musdSymbol,
    requireMusdQuote,
    walletAddress,
    fetchQuote
  } = params;

  const fromUpper = normalizeSymbol(tokenIn);
  const toUpper = normalizeSymbol(tokenOut);
  const musdUpper = normalizeSymbol(musdSymbol);

  if (!amountIn || num(amountIn) <= 0) {
    throw new Error('Amount must be greater than zero.');
  }

  if (fromUpper === toUpper) {
    throw new Error('Input and output tokens cannot be the same.');
  }

  const shouldForceMusd =
    requireMusdQuote && fromUpper !== musdUpper && toUpper !== musdUpper;

  if (!shouldForceMusd) {
    const direct = await fetchQuote({
      chainId,
      tokenIn,
      tokenOut,
      amountIn,
      slippageBps,
      walletAddress
    });

    return {
      ...direct,
      plan: 'direct',
      legs: [direct],
      note: buildViaMusdNote(direct.route || [])
    };
  }

  const firstLeg = await fetchQuote({
    chainId,
    tokenIn,
    tokenOut: musdSymbol,
    amountIn,
    slippageBps,
    walletAddress
  });

  const secondLeg = await fetchQuote({
    chainId,
    tokenIn: musdSymbol,
    tokenOut,
    amountIn: firstLeg.expected_out,
    slippageBps,
    walletAddress
  });

  const secondWorstLeg = await fetchQuote({
    chainId,
    tokenIn: musdSymbol,
    tokenOut,
    amountIn: firstLeg.min_out,
    slippageBps,
    walletAddress
  });

  const route = [tokenIn, musdSymbol, tokenOut];
  const totalFeeBps = mergeBps([firstLeg.total_fee_bps, secondLeg.total_fee_bps]);
  const protocolFeeBps = mergeBps([firstLeg.protocol_fee_bps, secondLeg.protocol_fee_bps]);
  const lpFeeBps = Math.max(0, totalFeeBps - protocolFeeBps);
  const depth = Math.min(
    Math.max(0, num(firstLeg.route_depth)),
    Math.max(0, num(secondLeg.route_depth))
  );

  return {
    chain_id: chainId,
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: amountIn,
    expected_out: secondLeg.expected_out,
    min_out: secondWorstLeg.min_out || secondLeg.min_out,
    slippage_bps: slippageBps,
    route,
    route_depth: String(depth || 0),
    liquidity_source: 'musd-forced',
    total_fee_bps: totalFeeBps,
    protocol_fee_bps: protocolFeeBps,
    lp_fee_bps: lpFeeBps,
    protocol_fee_amount_in: firstLeg.protocol_fee_amount_in || '0',
    engine: secondLeg.engine || firstLeg.engine || 'harmony-engine-v2',
    plan: 'via-musd',
    legs: [firstLeg, secondLeg, secondWorstLeg],
    note: buildViaMusdNote(route)
  };
}

