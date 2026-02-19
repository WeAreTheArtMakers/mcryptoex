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

function selectCollateralToken(registry: Registry): string {
  const fromEnv = process.env.BOOTSTRAP_COLLATERAL_TOKEN?.trim();
  if (fromEnv && ethers.isAddress(fromEnv)) {
    return fromEnv;
  }
  if (Array.isArray(registry.collaterals) && registry.collaterals.length > 0) {
    const candidate = registry.collaterals[0]?.token;
    if (candidate && ethers.isAddress(candidate)) {
      return candidate;
    }
  }
  const fallback = registry.collateralToken || '';
  if (fallback && ethers.isAddress(fallback)) {
    return fallback;
  }
  throw new Error(
    'no collateral token found; set BOOTSTRAP_COLLATERAL_TOKEN or ensure registry.collaterals is populated'
  );
}

function amountEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) return defaultValue;
  return value.trim();
}

async function maybeSetMockPrice(oracleAddress: string, collateralToken: string): Promise<void> {
  const enable = (process.env.BOOTSTRAP_SET_MOCK_ORACLE_PRICE || 'true').toLowerCase() === 'true';
  if (!enable) return;

  const priceE18 = process.env.BOOTSTRAP_ORACLE_PRICE_E18 || ethers.parseEther('1').toString();
  try {
    const oracle = await ethers.getContractAt('MockPriceOracle', oracleAddress);
    await (await oracle.setPrice(collateralToken, priceE18)).wait();
    console.log(`oracle price set: token=${collateralToken} priceE18=${priceE18}`);
  } catch (error) {
    console.log('oracle.setPrice skipped (non-mock oracle or missing role)');
    console.log(String(error));
  }
}

async function main(): Promise<void> {
  const registryPath = registryPathForNetwork();
  const registry = readRegistry(registryPath);

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error('no signer available; set PRIVATE_KEY in packages/contracts/.env');
  }
  const [deployer] = signers;

  const collateralTokenAddress = selectCollateralToken(registry);

  const musd = await ethers.getContractAt('MUSDToken', registry.contracts.musd);
  const stabilizer = await ethers.getContractAt('Stabilizer', registry.contracts.stabilizer);
  const factory = await ethers.getContractAt('HarmonyFactory', registry.contracts.harmonyFactory);
  const router = await ethers.getContractAt('HarmonyRouter', registry.contracts.harmonyRouter);
  const collateral = await ethers.getContractAt('IERC20Metadata', collateralTokenAddress);

  const collateralSymbol = await collateral.symbol();
  const collateralDecimals = Number(await collateral.decimals());

  const mintCollateralAmount = amountEnv('BOOTSTRAP_MINT_COLLATERAL_AMOUNT', '100');
  const lpCollateralAmount = amountEnv('BOOTSTRAP_LP_COLLATERAL_AMOUNT', '50');
  const lpMusdAmount = amountEnv('BOOTSTRAP_LP_MUSD_AMOUNT', '50');

  const mintCollateralRaw = ethers.parseUnits(mintCollateralAmount, collateralDecimals);
  const lpCollateralRaw = ethers.parseUnits(lpCollateralAmount, collateralDecimals);
  const lpMusdRaw = ethers.parseEther(lpMusdAmount);

  await maybeSetMockPrice(registry.contracts.oracle, collateralTokenAddress);

  await (await collateral.approve(await stabilizer.getAddress(), mintCollateralRaw)).wait();
  await (
    await stabilizer.mintWithCollateral(collateralTokenAddress, mintCollateralRaw, 0, deployer.address)
  ).wait();

  await (await collateral.approve(await router.getAddress(), lpCollateralRaw)).wait();
  await (await musd.approve(await router.getAddress(), lpMusdRaw)).wait();

  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const minMusd = (lpMusdRaw * 99n) / 100n;
  const minCollateral = (lpCollateralRaw * 99n) / 100n;

  await (
    await router.addLiquidity(
      await musd.getAddress(),
      collateralTokenAddress,
      lpMusdRaw,
      lpCollateralRaw,
      minMusd,
      minCollateral,
      deployer.address,
      deadline
    )
  ).wait();

  const pair = await factory.getPair(await musd.getAddress(), collateralTokenAddress);
  const musdBalance = await musd.balanceOf(deployer.address);
  const collateralBalance = await collateral.balanceOf(deployer.address);

  console.log(`bootstrap complete network=${network.name}`);
  console.log(`deployer=${deployer.address}`);
  console.log(`collateral=${collateralSymbol} ${collateralTokenAddress}`);
  console.log(`pair=${pair}`);
  console.log(`deployer_musd_balance=${ethers.formatEther(musdBalance)}`);
  console.log(`deployer_${collateralSymbol}_balance=${ethers.formatUnits(collateralBalance, collateralDecimals)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
