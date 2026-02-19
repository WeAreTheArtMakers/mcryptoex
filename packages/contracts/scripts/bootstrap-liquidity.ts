import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ethers, network } from 'hardhat';

type Registry = {
  contracts: {
    musd: string;
    stabilizer: string;
    oracle: string;
    harmonyFactory: string;
    harmonyRouter: string;
  };
  collaterals?: Array<{
    token: string;
    symbol?: string;
    decimals?: number;
  }>;
  collateralToken?: string | null;
};

type CollateralConfig = {
  token: string;
  symbol?: string;
};

const WRAPPED_NATIVE_DEFAULTS: Record<number, string> = {
  97: '0xae13d989dac2f0debff460ac112a837c89baa7cd', // WBNB (BSC testnet)
  11155111: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' // WETH (Sepolia)
};

const WRAPPED_NATIVE_ABI = [
  'function deposit() payable',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)'
] as const;

function registryPathForNetwork(): string {
  const explicit = process.env.ADDRESS_REGISTRY_PATH;
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }
  return join(__dirname, '..', 'deploy', `address-registry.${network.name}.json`);
}

function readRegistry(path: string): Registry {
  if (!existsSync(path)) {
    throw new Error(`registry file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Registry;
}

function parseCsv(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value || !value.trim()) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeSymbolEnvKey(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function amountEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) return defaultValue;
  return value.trim();
}

function amountEnvForSymbol(prefix: string, symbol: string, fallbackKey: string, defaultValue: string): string {
  const key = `${prefix}_${normalizeSymbolEnvKey(symbol)}_AMOUNT`;
  return amountEnv(key, amountEnv(fallbackKey, defaultValue));
}

function dedupeCollaterals(items: CollateralConfig[]): CollateralConfig[] {
  const seen = new Set<string>();
  const output: CollateralConfig[] = [];
  for (const item of items) {
    const token = item.token.trim();
    if (!ethers.isAddress(token)) continue;
    const lower = token.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    output.push({ token, symbol: item.symbol });
  }
  return output;
}

function resolveCollateralTargets(registry: Registry): CollateralConfig[] {
  const envMany = parseCsv(process.env.BOOTSTRAP_COLLATERAL_TOKENS).map((token) => ({ token }));
  const envSingle = process.env.BOOTSTRAP_COLLATERAL_TOKEN?.trim();

  const configured: CollateralConfig[] = [];
  if (Array.isArray(registry.collaterals) && registry.collaterals.length > 0) {
    for (const entry of registry.collaterals) {
      configured.push({ token: entry.token, symbol: entry.symbol });
    }
  }
  if (registry.collateralToken) {
    configured.push({ token: registry.collateralToken });
  }

  const merged: CollateralConfig[] = [];
  if (envMany.length > 0) {
    merged.push(...envMany);
  }
  if (envSingle && envSingle.length > 0) {
    merged.push({ token: envSingle });
  }
  if (merged.length === 0) {
    merged.push(...configured);
  }

  const deduped = dedupeCollaterals(merged);
  if (!deduped.length) {
    throw new Error('no collateral token found; set BOOTSTRAP_COLLATERAL_TOKENS or ensure registry.collaterals is populated');
  }
  return deduped;
}

async function maybeSetMockPrice(oracleAddress: string, tokenAddress: string, symbol: string): Promise<void> {
  if (!boolEnv('BOOTSTRAP_SET_MOCK_ORACLE_PRICE', true)) return;

  const specificPrice = process.env[`BOOTSTRAP_ORACLE_PRICE_${normalizeSymbolEnvKey(symbol)}_E18`];
  const priceE18 = specificPrice?.trim() || process.env.BOOTSTRAP_ORACLE_PRICE_E18 || ethers.parseEther('1').toString();
  try {
    const oracle = await ethers.getContractAt('MockPriceOracle', oracleAddress);
    await (await oracle.setPrice(tokenAddress, priceE18)).wait();
    console.log(`oracle price set: ${symbol}=${tokenAddress} priceE18=${priceE18}`);
  } catch (error) {
    console.log(`oracle.setPrice skipped for ${symbol} (non-mock oracle or missing role)`);
    console.log(String(error));
  }
}

async function tryMintErc20(tokenAddress: string, to: string, amount: bigint, symbol: string): Promise<boolean> {
  if (amount <= 0n) return true;

  try {
    const mintable = await ethers.getContractAt(['function mint(address,uint256) external'], tokenAddress);
    await (await mintable.mint(to, amount)).wait();
    console.log(`minted ${symbol}: +${amount.toString()} raw`);
    return true;
  } catch {
    return false;
  }
}

async function ensureTokenBalance(
  tokenAddress: string,
  owner: string,
  requiredRaw: bigint,
  symbol: string,
  decimals: number
): Promise<boolean> {
  if (requiredRaw <= 0n) return true;

  const token = await ethers.getContractAt('IERC20Metadata', tokenAddress);
  const current = await token.balanceOf(owner);
  if (current >= requiredRaw) return true;

  const deficit = requiredRaw - current;
  const minted = await tryMintErc20(tokenAddress, owner, deficit, symbol);
  if (!minted) {
    console.log(
      `insufficient ${symbol} for bootstrap. required=${ethers.formatUnits(requiredRaw, decimals)} available=${ethers.formatUnits(
        current,
        decimals
      )}`
    );
    return false;
  }

  const after = await token.balanceOf(owner);
  if (after < requiredRaw) {
    console.log(
      `still insufficient ${symbol} after mint attempt. required=${ethers.formatUnits(requiredRaw, decimals)} available=${ethers.formatUnits(
        after,
        decimals
      )}`
    );
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const registryPath = registryPathForNetwork();
  const registry = readRegistry(registryPath);

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error('no signer available; set PRIVATE_KEY in packages/contracts/.env');
  }
  const [deployer] = signers;

  const musd = await ethers.getContractAt('MUSDToken', registry.contracts.musd);
  const stabilizer = await ethers.getContractAt('Stabilizer', registry.contracts.stabilizer);
  const factory = await ethers.getContractAt('HarmonyFactory', registry.contracts.harmonyFactory);
  const router = await ethers.getContractAt('HarmonyRouter', registry.contracts.harmonyRouter);

  const collateralTargets = resolveCollateralTargets(registry);
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const createdPools: Array<{ symbol: string; token: string; pair: string }> = [];

  for (const target of collateralTargets) {
    const tokenAddress = target.token;
    const collateral = await ethers.getContractAt('IERC20Metadata', tokenAddress);
    const symbol = target.symbol || (await collateral.symbol());
    const decimals = Number(await collateral.decimals());

    await maybeSetMockPrice(registry.contracts.oracle, tokenAddress, symbol);

    const mintAmount = amountEnvForSymbol('BOOTSTRAP_MINT', symbol, 'BOOTSTRAP_MINT_COLLATERAL_AMOUNT', '120');
    const mintRaw = ethers.parseUnits(mintAmount, decimals);
    const canMint = await ensureTokenBalance(tokenAddress, deployer.address, mintRaw, symbol, decimals);
    if (!canMint) {
      console.log(`skip collateral mint path for ${symbol}`);
      continue;
    }

    await (await collateral.approve(await stabilizer.getAddress(), mintRaw)).wait();
    await (await stabilizer.mintWithCollateral(tokenAddress, mintRaw, 0, deployer.address)).wait();

    const lpTokenAmount = amountEnvForSymbol('BOOTSTRAP_LP', symbol, 'BOOTSTRAP_LP_COLLATERAL_AMOUNT', '40');
    const lpMusdAmount = amountEnvForSymbol('BOOTSTRAP_LP_MUSD', symbol, 'BOOTSTRAP_LP_MUSD_AMOUNT', '40');

    const lpTokenRaw = ethers.parseUnits(lpTokenAmount, decimals);
    const lpMusdRaw = ethers.parseEther(lpMusdAmount);

    const canProvideLpToken = await ensureTokenBalance(tokenAddress, deployer.address, lpTokenRaw, symbol, decimals);
    if (!canProvideLpToken) {
      console.log(`skip LP for ${symbol}: collateral balance is insufficient`);
      continue;
    }

    const musdBalance = await musd.balanceOf(deployer.address);
    if (musdBalance < lpMusdRaw) {
      console.log(
        `skip LP for ${symbol}: mUSD balance insufficient required=${ethers.formatEther(lpMusdRaw)} available=${ethers.formatEther(
          musdBalance
        )}`
      );
      continue;
    }

    await (await collateral.approve(await router.getAddress(), lpTokenRaw)).wait();
    await (await musd.approve(await router.getAddress(), lpMusdRaw)).wait();

    const minMusd = (lpMusdRaw * 99n) / 100n;
    const minCollateral = (lpTokenRaw * 99n) / 100n;

    await (
      await router.addLiquidity(
        await musd.getAddress(),
        tokenAddress,
        lpMusdRaw,
        lpTokenRaw,
        minMusd,
        minCollateral,
        deployer.address,
        deadline
      )
    ).wait();

    const pair = await factory.getPair(await musd.getAddress(), tokenAddress);
    createdPools.push({ symbol, token: tokenAddress, pair });
    console.log(`added LP: ${symbol} pair=${pair}`);
  }

  if (boolEnv('BOOTSTRAP_ENABLE_WRAPPED_NATIVE_POOL', true)) {
    const explicitWrapped = process.env.BOOTSTRAP_WRAPPED_NATIVE_TOKEN?.trim() || '';
    const fallbackWrapped = WRAPPED_NATIVE_DEFAULTS[Number(network.config.chainId || 0)] || '';
    const wrappedTokenAddress = explicitWrapped || fallbackWrapped;

    if (wrappedTokenAddress && ethers.isAddress(wrappedTokenAddress)) {
      const wrapped = await ethers.getContractAt(WRAPPED_NATIVE_ABI, wrappedTokenAddress);
      const symbol = await wrapped.symbol().catch(() => (network.name.includes('bsc') ? 'WBNB' : 'WETH'));
      const decimals = Number(await wrapped.decimals().catch(() => 18));

      const wrappedAmount = amountEnv('BOOTSTRAP_LP_WRAPPED_NATIVE_AMOUNT', network.name.includes('bsc') ? '0.5' : '0.2');
      const wrappedRaw = ethers.parseUnits(wrappedAmount, decimals);
      const musdForWrapped = ethers.parseEther(amountEnv('BOOTSTRAP_LP_MUSD_WRAPPED_AMOUNT', '40'));

      const wrappedBalance = await wrapped.balanceOf(deployer.address);
      if (wrappedBalance < wrappedRaw) {
        const deficit = wrappedRaw - wrappedBalance;
        const nativeBalance = await ethers.provider.getBalance(deployer.address);
        if (nativeBalance >= deficit) {
          await (await wrapped.deposit({ value: deficit })).wait();
          console.log(`wrapped native into ${symbol}: +${ethers.formatUnits(deficit, decimals)}`);
        } else {
          console.log(
            `skip ${symbol} pool: insufficient native balance for wrapping required=${ethers.formatEther(deficit)} available=${ethers.formatEther(
              nativeBalance
            )}`
          );
        }
      }

      const wrappedBalanceAfter = await wrapped.balanceOf(deployer.address);
      const musdBalance = await musd.balanceOf(deployer.address);
      if (wrappedBalanceAfter >= wrappedRaw && musdBalance >= musdForWrapped) {
        await (await wrapped.approve(await router.getAddress(), wrappedRaw)).wait();
        await (await musd.approve(await router.getAddress(), musdForWrapped)).wait();

        const minWrapped = (wrappedRaw * 99n) / 100n;
        const minMusd = (musdForWrapped * 99n) / 100n;

        await (
          await router.addLiquidity(
            await musd.getAddress(),
            wrappedTokenAddress,
            musdForWrapped,
            wrappedRaw,
            minMusd,
            minWrapped,
            deployer.address,
            deadline
          )
        ).wait();

        const pair = await factory.getPair(await musd.getAddress(), wrappedTokenAddress);
        createdPools.push({ symbol, token: wrappedTokenAddress, pair });
        console.log(`added LP: ${symbol} pair=${pair}`);
      } else {
        console.log(
          `skip ${symbol} pool: balances insufficient mUSD=${ethers.formatEther(musdBalance)} ${symbol}=${ethers.formatUnits(
            wrappedBalanceAfter,
            decimals
          )}`
        );
      }
    }
  }

  const musdBalance = await musd.balanceOf(deployer.address);

  console.log(`bootstrap complete network=${network.name}`);
  console.log(`deployer=${deployer.address}`);
  console.log(`pools_created=${createdPools.length}`);
  for (const pool of createdPools) {
    console.log(`pool ${pool.symbol}: token=${pool.token} pair=${pool.pair}`);
  }
  console.log(`deployer_musd_balance=${ethers.formatEther(musdBalance)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
