import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ethers } from 'hardhat';

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory('MockERC20');
  const collateral = await MockERC20.deploy('USD Coin', 'USDC', 6);
  await collateral.waitForDeployment();

  const tokenA = await MockERC20.deploy('Wrapped ETH', 'WETH', 18);
  await tokenA.waitForDeployment();
  const tokenB = await MockERC20.deploy('Wrapped BTC', 'WBTC', 8);
  await tokenB.waitForDeployment();

  const MUSDToken = await ethers.getContractFactory('MUSDToken');
  const musd = await MUSDToken.deploy(deployer.address);
  await musd.waitForDeployment();

  const MockPriceOracle = await ethers.getContractFactory('MockPriceOracle');
  const oracle = await MockPriceOracle.deploy(deployer.address);
  await oracle.waitForDeployment();

  const Stabilizer = await ethers.getContractFactory('Stabilizer');
  const stabilizer = await Stabilizer.deploy(await musd.getAddress(), await oracle.getAddress(), deployer.address);
  await stabilizer.waitForDeployment();

  const minterRole = await musd.MINTER_ROLE();
  await (await musd.grantRole(minterRole, await stabilizer.getAddress())).wait();

  await (
    await oracle.setPrice(await collateral.getAddress(), ethers.parseEther('1'))
  ).wait();
  await (
    await stabilizer.configureCollateral(
      await collateral.getAddress(),
      true,
      ethers.parseEther('0.5'),
      ethers.parseEther('2')
    )
  ).wait();

  const HarmonyFactory = await ethers.getContractFactory('HarmonyFactory');
  const factory = await HarmonyFactory.deploy(deployer.address);
  await factory.waitForDeployment();

  const HarmonyRouter = await ethers.getContractFactory('HarmonyRouter');
  const router = await HarmonyRouter.deploy(await factory.getAddress());
  await router.waitForDeployment();

  const registry = {
    network: 'hardhat',
    deployer: deployer.address,
    contracts: {
      musd: await musd.getAddress(),
      stabilizer: await stabilizer.getAddress(),
      oracle: await oracle.getAddress(),
      collateral: await collateral.getAddress(),
      harmonyFactory: await factory.getAddress(),
      harmonyRouter: await router.getAddress(),
      tokenA: await tokenA.getAddress(),
      tokenB: await tokenB.getAddress()
    }
  };

  const outDir = join(__dirname, '..', 'deploy');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'address-registry.hardhat.json');
  writeFileSync(outFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  console.log(`Local deployment complete -> ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
