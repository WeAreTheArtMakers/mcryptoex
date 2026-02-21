import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ethers, network } from 'hardhat';

const DEFAULT_STABLE_DEVIATION_BPS = 200n; // +/-2%
const E18 = 10n ** 18n;

type CollateralInput = {
  token: string;
  symbol?: string;
  minOraclePriceE18?: string;
  maxOraclePriceE18?: string;
};

type DeployConfig = {
  collateralToken?: string;
  oracleAddress?: string;
  collateralMinPriceE18?: string;
  collateralMaxPriceE18?: string;
  collaterals?: CollateralInput[];
  swapFeeBps?: number;
  protocolFeeBps?: number;
};

const DEFAULT_SWAP_FEE_BPS = 30;
const DEFAULT_PROTOCOL_FEE_BPS = 5;

function parseFeeBps(
  envName: string,
  configValue: number | undefined,
  fallback: number
): number {
  const envRaw = envForChain(envName);
  const raw = envRaw && envRaw.trim().length > 0 ? envRaw.trim() : configValue?.toString() || `${fallback}`;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${envName}=${raw}; expected integer bps`);
  }
  return parsed;
}

function readConfig(networkName: string): DeployConfig {
  const path = join(__dirname, '..', 'deploy', `${networkName}-config.json`);
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, 'utf8')) as DeployConfig;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function boolEnv(name: string, fallback = false): boolean {
  const raw = envForChain(name);
  if (!raw || !raw.trim()) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function envForChain(name: string): string | undefined {
  const suffix = network.name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return process.env[`${name}_${suffix}`] || process.env[name];
}

function stableBoundsE18(deviationBps: bigint): { min: string; max: string } {
  if (deviationBps > 200n) {
    throw new Error(
      `STABLE_COLLATERAL_MAX_DEVIATION_BPS exceeds allowed max (200 bps = 2%): ${deviationBps.toString()}`
    );
  }
  if (deviationBps >= 10_000n) {
    throw new Error(`invalid STABLE_COLLATERAL_MAX_DEVIATION_BPS=${deviationBps.toString()}`);
  }
  const min = (E18 * (10_000n - deviationBps)) / 10_000n;
  const max = (E18 * (10_000n + deviationBps)) / 10_000n;
  return { min: min.toString(), max: max.toString() };
}

function sanitizeAddress(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === ethers.ZeroAddress) return '';
  return trimmed;
}

function dedupeCollaterals(inputs: CollateralInput[]): CollateralInput[] {
  const byAddress = new Map<string, CollateralInput>();
  for (const item of inputs) {
    const token = sanitizeAddress(item.token);
    if (!token || !ethers.isAddress(token)) continue;
    byAddress.set(token.toLowerCase(), {
      token,
      symbol: item.symbol,
      minOraclePriceE18: item.minOraclePriceE18,
      maxOraclePriceE18: item.maxOraclePriceE18
    });
  }
  return Array.from(byAddress.values());
}

function resolveCollaterals(config: DeployConfig): CollateralInput[] {
  const collateralOverride = boolEnv('COLLATERAL_OVERRIDE', false);
  const envSingleCollateral = sanitizeAddress(envForChain('COLLATERAL_TOKEN'));
  const envCollateralList = parseCsv(envForChain('COLLATERAL_TOKENS')).map((token) => ({
    token
  }));

  const stableDeviationBps = BigInt(
    process.env.STABLE_COLLATERAL_MAX_DEVIATION_BPS || DEFAULT_STABLE_DEVIATION_BPS.toString()
  );
  const stableBounds = stableBoundsE18(stableDeviationBps);
  const stableEnvTokens = collateralOverride
    ? []
    : [
        {
          token: sanitizeAddress(envForChain('USDC_TOKEN_ADDRESS')),
          symbol: 'USDC'
        },
        {
          token: sanitizeAddress(envForChain('USDT_TOKEN_ADDRESS')),
          symbol: 'USDT'
        }
      ]
        .filter((x) => x.token.length > 0)
        .map((x) => ({
          token: x.token,
          symbol: x.symbol,
          minOraclePriceE18: stableBounds.min,
          maxOraclePriceE18: stableBounds.max
        }));

  const inputs: CollateralInput[] = [];
  if (!collateralOverride && Array.isArray(config.collaterals)) {
    inputs.push(...config.collaterals);
  }
  if (envSingleCollateral) {
    inputs.push({
      token: envSingleCollateral,
      minOraclePriceE18: envForChain('COLLATERAL_MIN_PRICE_E18') || config.collateralMinPriceE18,
      maxOraclePriceE18: envForChain('COLLATERAL_MAX_PRICE_E18') || config.collateralMaxPriceE18
    });
  }
  if (envCollateralList.length > 0) {
    inputs.push(...envCollateralList);
  }
  if (stableEnvTokens.length > 0) {
    inputs.push(...stableEnvTokens);
  }

  if (
    !collateralOverride &&
    inputs.length === 0 &&
    config.collateralToken &&
    sanitizeAddress(config.collateralToken)
  ) {
    inputs.push({
      token: config.collateralToken,
      minOraclePriceE18: config.collateralMinPriceE18,
      maxOraclePriceE18: config.collateralMaxPriceE18
    });
  }

  const fallbackMin = ethers.parseEther('0.5').toString();
  const fallbackMax = ethers.parseEther('2').toString();
  const deduped = dedupeCollaterals(inputs);
  return deduped.map((item) => ({
    token: item.token,
    symbol: item.symbol,
    minOraclePriceE18: item.minOraclePriceE18 || fallbackMin,
    maxOraclePriceE18: item.maxOraclePriceE18 || fallbackMax
  }));
}

async function main(): Promise<void> {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error('no deployer signer found; set PRIVATE_KEY in packages/contracts/.env');
  }
  const [deployer] = signers;
  const config = readConfig(network.name);
  const collaterals = resolveCollaterals(config);

  let oracleAddress = envForChain('ORACLE_ADDRESS') || config.oracleAddress;
  if (!oracleAddress || oracleAddress === ethers.ZeroAddress) {
    const MockPriceOracle = await ethers.getContractFactory('MockPriceOracle');
    const oracle = await MockPriceOracle.deploy(deployer.address);
    await oracle.waitForDeployment();
    oracleAddress = await oracle.getAddress();
  }

  const MUSDToken = await ethers.getContractFactory('MUSDToken');
  const musd = await MUSDToken.deploy(deployer.address);
  await musd.waitForDeployment();

  const Stabilizer = await ethers.getContractFactory('Stabilizer');
  const stabilizer = await Stabilizer.deploy(await musd.getAddress(), oracleAddress, deployer.address);
  await stabilizer.waitForDeployment();

  const minterRole = await musd.MINTER_ROLE();
  await (await musd.grantRole(minterRole, await stabilizer.getAddress())).wait();

  const HarmonyFactory = await ethers.getContractFactory('HarmonyFactory');
  const factory = await HarmonyFactory.deploy(deployer.address);
  await factory.waitForDeployment();

  const HarmonyRouter = await ethers.getContractFactory('HarmonyRouter');
  const router = await HarmonyRouter.deploy(await factory.getAddress());
  await router.waitForDeployment();

  const swapFeeBps = parseFeeBps('SWAP_FEE_BPS', config.swapFeeBps, DEFAULT_SWAP_FEE_BPS);
  const protocolFeeBps = parseFeeBps('PROTOCOL_FEE_BPS', config.protocolFeeBps, DEFAULT_PROTOCOL_FEE_BPS);

  if (swapFeeBps > 1_000) {
    throw new Error(`SWAP_FEE_BPS exceeds cap (1000): ${swapFeeBps}`);
  }
  if (protocolFeeBps > 30) {
    throw new Error(`PROTOCOL_FEE_BPS exceeds cap (30): ${protocolFeeBps}`);
  }
  if (protocolFeeBps > swapFeeBps) {
    throw new Error(`PROTOCOL_FEE_BPS must be <= SWAP_FEE_BPS (${protocolFeeBps} > ${swapFeeBps})`);
  }

  await (await factory.setFeeParams(swapFeeBps, protocolFeeBps)).wait();

  const ResonanceVault = await ethers.getContractFactory('ResonanceVault');
  const resonanceVault = await ResonanceVault.deploy(
    await router.getAddress(),
    await musd.getAddress(),
    await factory.getAddress(),
    deployer.address
  );
  await resonanceVault.waitForDeployment();
  await (await factory.setTreasury(await resonanceVault.getAddress())).wait();

  const configuredCollaterals: Array<{
    token: string;
    symbol: string;
    decimals: number;
    minOraclePriceE18: string;
    maxOraclePriceE18: string;
  }> = [];

  for (const collateral of collaterals) {
    await (
      await stabilizer.configureCollateral(
        collateral.token,
        true,
        collateral.minOraclePriceE18!,
        collateral.maxOraclePriceE18!
      )
    ).wait();

    const token = await ethers.getContractAt('IERC20Metadata', collateral.token);
    const symbol = collateral.symbol || (await token.symbol());
    const decimals = Number(await token.decimals());
    configuredCollaterals.push({
      token: collateral.token,
      symbol,
      decimals,
      minOraclePriceE18: collateral.minOraclePriceE18!,
      maxOraclePriceE18: collateral.maxOraclePriceE18!
    });

    await (await resonanceVault.setTokenAllowlist(collateral.token, true)).wait();
  }

  const opsBudgetAddress = sanitizeAddress(envForChain('OPS_BUDGET_ADDRESS')) || deployer.address;
  const liquidityIncentivesAddress = sanitizeAddress(envForChain('LIQUIDITY_INCENTIVES_ADDRESS')) || deployer.address;
  const reserveOrBuybackAddress = sanitizeAddress(envForChain('RESERVE_OR_BUYBACK_ADDRESS')) || deployer.address;

  await (
    await resonanceVault.setDistributionConfig(
      opsBudgetAddress,
      liquidityIncentivesAddress,
      reserveOrBuybackAddress,
      4_000,
      4_000,
      2_000
    )
  ).wait();

  const registry = {
    network: network.name,
    chainId: network.config.chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      musd: await musd.getAddress(),
      stabilizer: await stabilizer.getAddress(),
      oracle: oracleAddress,
      harmonyFactory: await factory.getAddress(),
      harmonyRouter: await router.getAddress(),
      resonanceVault: await resonanceVault.getAddress()
    },
    fees: {
      swapFeeBps,
      protocolFeeBps
    },
    treasury: {
      opsBudgetAddress,
      liquidityIncentivesAddress,
      reserveOrBuybackAddress
    },
    collaterals: configuredCollaterals,
    collateralToken: configuredCollaterals.length > 0 ? configuredCollaterals[0].token : null
  };

  const outDir = join(__dirname, '..', 'deploy');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `address-registry.${network.name}.json`);
  writeFileSync(outFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  console.log(`Deployment registry written to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
