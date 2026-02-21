import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ethers, network, run } from 'hardhat';

type RegistryCollateral = {
  token: string;
  symbol?: string;
  decimals?: number;
};

type RegistryTarget = {
  symbol?: string;
  token?: string;
  pair?: string;
  decimals?: number;
};

type AddressRegistry = {
  deployer: string;
  contracts: {
    musd: string;
    stabilizer: string;
    oracle: string;
    harmonyFactory: string;
    harmonyRouter: string;
    resonanceVault: string;
  };
  collaterals?: RegistryCollateral[];
  targets?: RegistryTarget[];
};

type VerifyJob = {
  label: string;
  address: string;
  contract: string;
  constructorArguments: unknown[];
  strict?: boolean;
};

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function envCsv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function readRegistry(): AddressRegistry {
  const registryPath =
    process.env.VERIFY_REGISTRY_PATH ||
    join(__dirname, '..', 'deploy', `address-registry.${network.name}.json`);
  if (!existsSync(registryPath)) {
    throw new Error(
      `registry not found at ${registryPath}. Set VERIFY_REGISTRY_PATH or deploy first.`
    );
  }
  return JSON.parse(readFileSync(registryPath, 'utf8')) as AddressRegistry;
}

function requireExplorerApiKey() {
  const keyByNetwork: Record<string, string> = {
    bscTestnet: 'BSCSCAN_API_KEY',
    sepolia: 'ETHERSCAN_API_KEY'
  };
  const envName = keyByNetwork[network.name];
  if (!envName) return;
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(
      `${envName} is required for verify/publish on ${network.name}. Set it in packages/contracts/.env`
    );
  }
}

function pushJob(jobs: VerifyJob[], seen: Set<string>, job: VerifyJob) {
  if (!ethers.isAddress(job.address)) return;
  const key = `${job.address.toLowerCase()}::${job.contract}`;
  if (seen.has(key)) return;
  seen.add(key);
  jobs.push(job);
}

function isAlreadyVerifiedError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('already verified') ||
    lower.includes('already been verified') ||
    lower.includes('source code already verified') ||
    lower.includes('smart-contract already verified')
  );
}

function collateralNameFor(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === 'USDC') return 'USD Coin (Mock)';
  if (normalized === 'USDT') return 'Tether USD (Mock)';
  return null;
}

async function verifyJob(job: VerifyJob): Promise<'verified' | 'already' | 'skipped' | 'failed'> {
  try {
    await run('verify:verify', {
      address: job.address,
      contract: job.contract,
      constructorArguments: job.constructorArguments
    });
    console.log(`verified ${job.label}: ${job.address}`);
    return 'verified';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAlreadyVerifiedError(message)) {
      console.log(`already verified ${job.label}: ${job.address}`);
      return 'already';
    }
    if (!job.strict) {
      console.warn(`skipped ${job.label}: ${job.address} (${message})`);
      return 'skipped';
    }
    console.error(`failed ${job.label}: ${job.address} (${message})`);
    return 'failed';
  }
}

async function main() {
  requireExplorerApiKey();
  const registry = readRegistry();
  const includePairs = envBool('VERIFY_INCLUDE_PAIRS', true);
  const includeCollaterals = envBool('VERIFY_INCLUDE_COLLATERALS', true);

  const jobs: VerifyJob[] = [];
  const seen = new Set<string>();

  const core = registry.contracts;
  const deployer = registry.deployer;

  pushJob(jobs, seen, {
    label: 'MUSDToken',
    address: core.musd,
    contract: 'contracts/musd/MUSDToken.sol:MUSDToken',
    constructorArguments: [deployer],
    strict: true
  });

  pushJob(jobs, seen, {
    label: 'Stabilizer',
    address: core.stabilizer,
    contract: 'contracts/musd/Stabilizer.sol:Stabilizer',
    constructorArguments: [core.musd, core.oracle, deployer],
    strict: true
  });

  pushJob(jobs, seen, {
    label: 'MockPriceOracle',
    address: core.oracle,
    contract: 'contracts/mocks/MockPriceOracle.sol:MockPriceOracle',
    constructorArguments: [deployer],
    strict: false
  });

  pushJob(jobs, seen, {
    label: 'HarmonyFactory',
    address: core.harmonyFactory,
    contract: 'contracts/harmony/HarmonyFactory.sol:HarmonyFactory',
    constructorArguments: [deployer],
    strict: true
  });

  pushJob(jobs, seen, {
    label: 'HarmonyRouter',
    address: core.harmonyRouter,
    contract: 'contracts/harmony/HarmonyRouter.sol:HarmonyRouter',
    constructorArguments: [core.harmonyFactory],
    strict: true
  });

  pushJob(jobs, seen, {
    label: 'ResonanceVault',
    address: core.resonanceVault,
    contract: 'contracts/treasury/ResonanceVault.sol:ResonanceVault',
    constructorArguments: [core.harmonyRouter, core.musd, core.harmonyFactory, deployer],
    strict: true
  });

  if (includePairs) {
    for (const target of registry.targets || []) {
      if (!target.pair) continue;
      pushJob(jobs, seen, {
        label: `${target.symbol || 'PAIR'} LP (mHLP)`,
        address: target.pair,
        contract: 'contracts/harmony/HarmonyPair.sol:HarmonyPair',
        constructorArguments: [],
        strict: true
      });
    }
    for (const pairAddress of envCsv('VERIFY_EXTRA_PAIR_ADDRESSES')) {
      pushJob(jobs, seen, {
        label: 'Extra LP (mHLP)',
        address: pairAddress,
        contract: 'contracts/harmony/HarmonyPair.sol:HarmonyPair',
        constructorArguments: [],
        strict: false
      });
    }
  }

  if (includeCollaterals) {
    for (const collateral of registry.collaterals || []) {
      if (!collateral.token || !ethers.isAddress(collateral.token)) continue;
      const symbol = collateral.symbol || 'COLLATERAL';
      const name = collateralNameFor(symbol);
      if (!name) {
        console.warn(
          `skip collateral ${symbol} (${collateral.token}) - unknown constructor name for MockERC20`
        );
        continue;
      }
      pushJob(jobs, seen, {
        label: `${symbol} MockERC20`,
        address: collateral.token,
        contract: 'contracts/mocks/MockERC20.sol:MockERC20',
        constructorArguments: [name, symbol.toUpperCase(), collateral.decimals || 18],
        strict: false
      });
    }
  }

  if (jobs.length === 0) {
    console.log('no contracts found to verify');
    return;
  }

  console.log(`network=${network.name} jobs=${jobs.length}`);
  let verified = 0;
  let already = 0;
  let skipped = 0;
  let failed = 0;

  for (const job of jobs) {
    const result = await verifyJob(job);
    if (result === 'verified') verified += 1;
    if (result === 'already') already += 1;
    if (result === 'skipped') skipped += 1;
    if (result === 'failed') failed += 1;
  }

  console.log(
    `verify summary: verified=${verified} already=${already} skipped=${skipped} failed=${failed}`
  );
  if (failed > 0) {
    throw new Error(`verification failed for ${failed} strict contract(s)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
