import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ethers, network } from 'hardhat';

type Registry = {
  contracts: {
    musd: string;
    harmonyRouter: string;
  };
  collaterals?: Array<{
    token: string;
    symbol?: string;
    decimals?: number;
  }>;
};

const WRAPPED_NATIVE_DEFAULTS: Record<number, string> = {
  97: '0xae13d989dac2f0debff460ac112a837c89baa7cd',
  11155111: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14'
};

function registryPathForNetwork(): string {
  const explicit = process.env.ADDRESS_REGISTRY_PATH;
  if (explicit && explicit.trim().length > 0) return explicit;
  return join(__dirname, '..', 'deploy', `address-registry.${network.name}.json`);
}

function readRegistry(path: string): Registry {
  if (!existsSync(path)) throw new Error(`registry file not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Registry;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function resolveTokenAddress(registry: Registry, symbol: string): string {
  const normalized = normalizeSymbol(symbol);
  if (normalized === 'MUSD') return registry.contracts.musd;

  const byEnv = process.env[`SMOKE_SWAP_TOKEN_${normalized}_ADDRESS`];
  if (byEnv && ethers.isAddress(byEnv.trim())) return byEnv.trim();

  if (Array.isArray(registry.collaterals)) {
    const found = registry.collaterals.find((item) => normalizeSymbol(item.symbol || '') === normalized);
    if (found && ethers.isAddress(found.token)) return found.token;
  }

  if (normalized === 'WBNB' || normalized === 'WETH') {
    const wrappedFromEnv = process.env.BOOTSTRAP_WRAPPED_NATIVE_TOKEN?.trim();
    if (wrappedFromEnv && ethers.isAddress(wrappedFromEnv)) return wrappedFromEnv;
    const chainId = Number(network.config.chainId || 0);
    const fallback = WRAPPED_NATIVE_DEFAULTS[chainId];
    if (fallback && ethers.isAddress(fallback)) return fallback;
  }

  throw new Error(
    `unable to resolve token address for symbol=${normalized}; set SMOKE_SWAP_TOKEN_${normalized}_ADDRESS or configure registry collaterals`
  );
}

async function ensureBalance(tokenAddress: string, owner: string, required: bigint): Promise<void> {
  const token = await ethers.getContractAt('IERC20Metadata', tokenAddress);
  const current = await token.balanceOf(owner);
  if (current >= required) return;

  const deficit = required - current;
  try {
    const mintable = await ethers.getContractAt(['function mint(address,uint256) external'], tokenAddress);
    await (await mintable.mint(owner, deficit)).wait();
  } catch {
    throw new Error(
      `insufficient token balance and mint failed token=${tokenAddress} required=${required.toString()} current=${current.toString()}`
    );
  }
}

async function main(): Promise<void> {
  const registry = readRegistry(registryPathForNetwork());
  const signers = await ethers.getSigners();
  if (!signers.length) {
    throw new Error('no signer available; set PRIVATE_KEY in packages/contracts/.env');
  }
  const [deployer] = signers;

  const tokenInSymbol = normalizeSymbol(process.env.SMOKE_SWAP_TOKEN_IN || 'USDT');
  const tokenOutSymbol = normalizeSymbol(process.env.SMOKE_SWAP_TOKEN_OUT || 'MUSD');
  if (tokenOutSymbol !== 'MUSD') {
    throw new Error(`SMOKE_SWAP_TOKEN_OUT must be MUSD for this script. received=${tokenOutSymbol}`);
  }

  const tokenInAddress = resolveTokenAddress(registry, tokenInSymbol);
  const tokenOutAddress = registry.contracts.musd;
  const routerAddress = registry.contracts.harmonyRouter;
  if (!ethers.isAddress(routerAddress)) throw new Error(`invalid router address: ${routerAddress}`);

  const tokenIn = await ethers.getContractAt('IERC20Metadata', tokenInAddress);
  const decimals = Number(await tokenIn.decimals());
  const amountIn = ethers.parseUnits(process.env.SMOKE_SWAP_AMOUNT_IN || '1', decimals);
  const slippageBps = Number(process.env.SMOKE_SWAP_SLIPPAGE_BPS || '300');
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 3_000) {
    throw new Error(`invalid SMOKE_SWAP_SLIPPAGE_BPS=${slippageBps}`);
  }

  await ensureBalance(tokenInAddress, deployer.address, amountIn);

  const router = await ethers.getContractAt(
    [
      'function getAmountsOut(uint256,address[]) view returns (uint256[])',
      'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])'
    ],
    routerAddress
  );

  const path = [tokenInAddress, tokenOutAddress];
  const amountsOut = await router.getAmountsOut(amountIn, path);
  const expectedOut = amountsOut[amountsOut.length - 1];
  const minOut = (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;

  const allowance = await tokenIn.allowance(deployer.address, routerAddress);
  if (allowance < amountIn) {
    await (await tokenIn.approve(routerAddress, ethers.MaxUint256)).wait();
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1_200);
  const tx = await router.swapExactTokensForTokens(amountIn, minOut, path, deployer.address, deadline);
  const receipt = await tx.wait();

  console.log(`smoke swap complete network=${network.name}`);
  console.log(`deployer=${deployer.address}`);
  console.log(`token_in=${tokenInSymbol} ${tokenInAddress}`);
  console.log(`token_out=MUSD ${tokenOutAddress}`);
  console.log(`amount_in_raw=${amountIn.toString()}`);
  console.log(`expected_out_raw=${expectedOut.toString()}`);
  console.log(`min_out_raw=${minOut.toString()}`);
  console.log(`tx_hash=${tx.hash}`);
  console.log(`gas_used=${receipt?.gasUsed?.toString() || 'n/a'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
