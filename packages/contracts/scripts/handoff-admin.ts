import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ethers } from 'hardhat';

type AddressRegistry = {
  contracts: {
    musd: string;
    stabilizer: string;
    harmonyFactory: string;
    harmonyRouter: string;
  };
};

function readRegistry(pathInput: string): AddressRegistry {
  const fullPath = resolve(pathInput);
  return JSON.parse(readFileSync(fullPath, 'utf8')) as AddressRegistry;
}

async function main(): Promise<void> {
  const [operator] = await ethers.getSigners();
  const registryPath = process.env.ADDRESS_REGISTRY_PATH || './deploy/address-registry.hardhat.json';
  const newAdmin = process.env.NEW_ADMIN_ADDRESS;
  const revokeDeployer = (process.env.REVOKE_DEPLOYER_ROLES || 'false').toLowerCase() === 'true';

  if (!newAdmin || !ethers.isAddress(newAdmin)) {
    throw new Error('NEW_ADMIN_ADDRESS must be set to a valid address');
  }

  const registry = readRegistry(registryPath);
  const musd = await ethers.getContractAt('MUSDToken', registry.contracts.musd);
  const stabilizer = await ethers.getContractAt('Stabilizer', registry.contracts.stabilizer);
  const factory = await ethers.getContractAt('HarmonyFactory', registry.contracts.harmonyFactory);
  const router = await ethers.getContractAt('HarmonyRouter', registry.contracts.harmonyRouter);

  const defaultAdminRole = await musd.DEFAULT_ADMIN_ROLE();
  const minterRole = await musd.MINTER_ROLE();
  const pauserRole = await musd.PAUSER_ROLE();

  const governorRole = await stabilizer.GOVERNOR_ROLE();
  const operatorRole = await stabilizer.OPERATOR_ROLE();
  const stabilizerPauserRole = await stabilizer.PAUSER_ROLE();
  const stabilizerDefaultAdminRole = await stabilizer.DEFAULT_ADMIN_ROLE();

  if (!(await musd.hasRole(defaultAdminRole, newAdmin))) {
    await (await musd.grantRole(defaultAdminRole, newAdmin)).wait();
  }
  if (!(await musd.hasRole(pauserRole, newAdmin))) {
    await (await musd.grantRole(pauserRole, newAdmin)).wait();
  }
  if (!(await musd.hasRole(minterRole, registry.contracts.stabilizer))) {
    await (await musd.grantRole(minterRole, registry.contracts.stabilizer)).wait();
  }

  if (!(await stabilizer.hasRole(stabilizerDefaultAdminRole, newAdmin))) {
    await (await stabilizer.grantRole(stabilizerDefaultAdminRole, newAdmin)).wait();
  }
  if (!(await stabilizer.hasRole(governorRole, newAdmin))) {
    await (await stabilizer.grantRole(governorRole, newAdmin)).wait();
  }
  if (!(await stabilizer.hasRole(operatorRole, newAdmin))) {
    await (await stabilizer.grantRole(operatorRole, newAdmin)).wait();
  }
  if (!(await stabilizer.hasRole(stabilizerPauserRole, newAdmin))) {
    await (await stabilizer.grantRole(stabilizerPauserRole, newAdmin)).wait();
  }

  await (await factory.transferOwnership(newAdmin)).wait();
  await (await router.transferOwnership(newAdmin)).wait();

  if (revokeDeployer) {
    if (await musd.hasRole(defaultAdminRole, operator.address)) {
      await (await musd.revokeRole(defaultAdminRole, operator.address)).wait();
    }
    if (await musd.hasRole(pauserRole, operator.address)) {
      await (await musd.revokeRole(pauserRole, operator.address)).wait();
    }

    if (await stabilizer.hasRole(stabilizerDefaultAdminRole, operator.address)) {
      await (await stabilizer.revokeRole(stabilizerDefaultAdminRole, operator.address)).wait();
    }
    if (await stabilizer.hasRole(governorRole, operator.address)) {
      await (await stabilizer.revokeRole(governorRole, operator.address)).wait();
    }
    if (await stabilizer.hasRole(operatorRole, operator.address)) {
      await (await stabilizer.revokeRole(operatorRole, operator.address)).wait();
    }
    if (await stabilizer.hasRole(stabilizerPauserRole, operator.address)) {
      await (await stabilizer.revokeRole(stabilizerPauserRole, operator.address)).wait();
    }
  }

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        registryPath: resolve(registryPath),
        newAdmin,
        revokeDeployer
      },
      null,
      2
    )
  );
  console.log('Reminder: new admin must call acceptOwnership() on HarmonyFactory and HarmonyRouter.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
