import { ethers, network } from 'hardhat';

function amountEnv(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function deployMockStable(params: {
  name: string;
  symbol: string;
  decimals: number;
  seedAmount: string;
  recipient: string;
}) {
  const { name, symbol, decimals, seedAmount, recipient } = params;
  const MockERC20 = await ethers.getContractFactory('MockERC20');
  const token = await MockERC20.deploy(name, symbol, decimals);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  const seedRaw = ethers.parseUnits(seedAmount, decimals);
  await (await token.mint(recipient, seedRaw)).wait();
  return tokenAddress;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error('no signer available; set PRIVATE_KEY in packages/contracts/.env');
  }

  const usdcDecimals = intEnv('MOCK_USDC_DECIMALS', 18);
  const usdtDecimals = intEnv('MOCK_USDT_DECIMALS', 18);
  const usdcSeedAmount = amountEnv('MOCK_USDC_SEED_AMOUNT', '1000000');
  const usdtSeedAmount = amountEnv('MOCK_USDT_SEED_AMOUNT', '1000000');

  const usdc = await deployMockStable({
    name: 'USD Coin (Mock)',
    symbol: 'USDC',
    decimals: usdcDecimals,
    seedAmount: usdcSeedAmount,
    recipient: deployer.address
  });

  const usdt = await deployMockStable({
    name: 'Tether USD (Mock)',
    symbol: 'USDT',
    decimals: usdtDecimals,
    seedAmount: usdtSeedAmount,
    recipient: deployer.address
  });

  console.log(`network=${network.name} chainId=${network.config.chainId}`);
  console.log(`deployer=${deployer.address}`);
  console.log(`USDC_TOKEN_ADDRESS=${usdc}`);
  console.log(`USDT_TOKEN_ADDRESS=${usdt}`);
  console.log(`MOCK_USDC_DECIMALS=${usdcDecimals}`);
  console.log(`MOCK_USDT_DECIMALS=${usdtDecimals}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
