import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ethers, network } from 'hardhat';

type DeployConfig = {
  collateralToken?: string;
  oracleAddress?: string;
  collateralMinPriceE18?: string;
  collateralMaxPriceE18?: string;
};

function readConfig(networkName: string): DeployConfig {
  const path = join(__dirname, '..', 'deploy', `${networkName}-config.json`);
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, 'utf8')) as DeployConfig;
}

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const config = readConfig(network.name);

  const collateralTokenFromEnv = process.env.COLLATERAL_TOKEN;
  const collateralToken = collateralTokenFromEnv || config.collateralToken;

  let oracleAddress = process.env.ORACLE_ADDRESS || config.oracleAddress;
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

  if (collateralToken) {
    const minPrice = config.collateralMinPriceE18 || ethers.parseEther('0.5').toString();
    const maxPrice = config.collateralMaxPriceE18 || ethers.parseEther('2').toString();

    await (
      await stabilizer.configureCollateral(collateralToken, true, minPrice, maxPrice)
    ).wait();
  }

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
      harmonyRouter: await router.getAddress()
    },
    collateralToken: collateralToken || null
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
