import { ethers as hhEthers } from 'hardhat';
import { ethers } from 'ethers';

type GasStep = {
  label: string;
  gasUsed: bigint;
};

async function runLocalGasProfile(): Promise<GasStep[]> {
  const [deployer, ops, incentives, reserve] = await hhEthers.getSigners();
  const steps: GasStep[] = [];

  async function record(label: string, txPromise: Promise<any>): Promise<void> {
    const tx = await txPromise;
    const receipt = await tx.wait();
    steps.push({
      label,
      gasUsed: receipt?.gasUsed ?? 0n
    });
  }

  async function deployWithGas(label: string, factoryName: string, args: any[]) {
    const factory = await hhEthers.getContractFactory(factoryName);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    const deploymentTx = contract.deploymentTransaction();
    const receipt = deploymentTx ? await deploymentTx.wait() : null;
    steps.push({
      label,
      gasUsed: receipt?.gasUsed ?? 0n
    });
    return contract;
  }

  const usdc = await deployWithGas('deploy USDC mock', 'MockERC20', ['USD Coin', 'USDC', 6]);
  const usdt = await deployWithGas('deploy USDT mock', 'MockERC20', ['Tether USD', 'USDT', 6]);
  const oracle = await deployWithGas('deploy oracle', 'MockPriceOracle', [deployer.address]);
  const musd = await deployWithGas('deploy mUSD token', 'MUSDToken', [deployer.address]);
  const stabilizer = await deployWithGas('deploy stabilizer', 'Stabilizer', [
    await musd.getAddress(),
    await oracle.getAddress(),
    deployer.address
  ]);

  const minterRole = await musd.MINTER_ROLE();
  await record('grant minter role', musd.grantRole(minterRole, await stabilizer.getAddress()));

  const factory = await deployWithGas('deploy harmony factory', 'HarmonyFactory', [deployer.address]);
  const router = await deployWithGas('deploy harmony router', 'HarmonyRouter', [await factory.getAddress()]);

  await record('set fee params', factory.setFeeParams(30, 5));

  const vault = await deployWithGas('deploy resonance vault', 'ResonanceVault', [
    await router.getAddress(),
    await musd.getAddress(),
    await factory.getAddress(),
    deployer.address
  ]);

  await record('set treasury', factory.setTreasury(await vault.getAddress()));
  await record(
    'set distribution config',
    vault.setDistributionConfig(ops.address, incentives.address, reserve.address, 4_000, 4_000, 2_000)
  );

  await record('oracle set USDC', oracle.setPrice(await usdc.getAddress(), hhEthers.parseEther('1')));
  await record('oracle set USDT', oracle.setPrice(await usdt.getAddress(), hhEthers.parseEther('1')));

  await record(
    'configure collateral USDC',
    stabilizer.configureCollateral(await usdc.getAddress(), true, hhEthers.parseEther('0.98'), hhEthers.parseEther('1.02'))
  );
  await record(
    'configure collateral USDT',
    stabilizer.configureCollateral(await usdt.getAddress(), true, hhEthers.parseEther('0.98'), hhEthers.parseEther('1.02'))
  );

  await record('vault allowlist USDC', vault.setTokenAllowlist(await usdc.getAddress(), true));
  await record('vault allowlist USDT', vault.setTokenAllowlist(await usdt.getAddress(), true));

  return steps;
}

async function gasPriceFor(name: string, url: string): Promise<bigint> {
  try {
    const provider = new ethers.JsonRpcProvider(url);
    const fee = await provider.getFeeData();
    const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
    if (gasPrice > 0n) return gasPrice;
  } catch {
    // fall through to env/default fallback
  }

  if (name === 'sepolia') {
    return BigInt(process.env.SEPOLIA_GAS_PRICE_WEI || ethers.parseUnits('25', 'gwei').toString());
  }
  return BigInt(process.env.BSC_TESTNET_GAS_PRICE_WEI || ethers.parseUnits('30', 'gwei').toString());
}

function fmtEth(value: bigint): string {
  return ethers.formatEther(value);
}

async function main(): Promise<void> {
  const steps = await runLocalGasProfile();
  const totalGas = steps.reduce((sum, step) => sum + step.gasUsed, 0n);

  const sepoliaRpc = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
  const bscRpc = process.env.BSC_TESTNET_RPC_URL || 'https://bsc-testnet-rpc.publicnode.com';

  const [sepoliaGasPrice, bscGasPrice] = await Promise.all([
    gasPriceFor('sepolia', sepoliaRpc),
    gasPriceFor('bscTestnet', bscRpc)
  ]);

  const sepoliaCost = totalGas * sepoliaGasPrice;
  const bscCost = totalGas * bscGasPrice;
  const sepoliaWithBuffer = (sepoliaCost * 130n) / 100n;
  const bscWithBuffer = (bscCost * 130n) / 100n;

  console.log('=== deploy gas profile (units) ===');
  for (const step of steps) {
    console.log(`${step.label}: ${step.gasUsed.toString()}`);
  }
  console.log(`total_gas_units=${totalGas.toString()}`);

  console.log('=== live network native estimates ===');
  console.log(`sepolia_gas_price_wei=${sepoliaGasPrice.toString()}`);
  console.log(`bsc_testnet_gas_price_wei=${bscGasPrice.toString()}`);
  console.log(`sepolia_estimated_eth=${fmtEth(sepoliaCost)}`);
  console.log(`bsc_testnet_estimated_bnb=${fmtEth(bscCost)}`);
  console.log(`sepolia_recommended_eth_with_30pct_buffer=${fmtEth(sepoliaWithBuffer)}`);
  console.log(`bsc_recommended_bnb_with_30pct_buffer=${fmtEth(bscWithBuffer)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
