import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Wallet } from 'ethers';
import { ethers, network } from 'hardhat';

type Registry = {
  contracts?: {
    musd?: string;
  };
};

type BotWalletRecord = {
  label: string;
  network: string;
  chainId: number;
  address: string;
  privateKey: string;
  createdAt: string;
  nativeFunded: string;
  musdFunded: string;
  nativeTxHash?: string;
  musdTxHash?: string;
};

const MUSD_ABI = [
  'function mint(address,uint256) external',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)'
] as const;

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function sanitizeLabel(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return normalized.length > 0 ? normalized : `seed-bot-${Date.now()}`;
}

function repoRoot(): string {
  return join(__dirname, '..', '..', '..');
}

function defaultSecretsFile(): string {
  return join(repoRoot(), '.local-secrets', 'seed-bot-wallets.json');
}

function defaultRegistryPath(): string {
  return join(__dirname, '..', 'deploy', `address-registry.${network.name}.json`);
}

function readRegistry(path: string): Registry {
  if (!existsSync(path)) {
    throw new Error(`address registry not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Registry;
}

function readRecords(path: string): BotWalletRecord[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BotWalletRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSecrets(path: string, entry: BotWalletRecord): void {
  const records = readRecords(path);
  records.unshift(entry);
  writeFileSync(path, `${JSON.stringify(records.slice(0, 300), null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error('no signer available; set PRIVATE_KEY in packages/contracts/.env');
  }

  const label = sanitizeLabel(process.env.BOT_WALLET_LABEL || `modx-seed-${network.name}`);
  const wallet = Wallet.createRandom();
  const chainId = Number(network.config.chainId || 0);
  const nativeAmountText = process.env.BOT_WALLET_NATIVE_AMOUNT || (chainId === 97 ? '0.02' : '0.01');
  const musdAmountText = process.env.BOT_WALLET_MUSD_AMOUNT || '250';
  const skipFunding = boolEnv('BOT_WALLET_SKIP_FUNDING', false);
  const secretsPath = process.env.BOT_WALLET_FILE?.trim() || defaultSecretsFile();
  const secretDir = dirname(secretsPath);
  const registryPath = process.env.ADDRESS_REGISTRY_PATH?.trim() || defaultRegistryPath();

  mkdirSync(secretDir, { recursive: true });

  let nativeFunded = '0';
  let musdFunded = '0';
  let nativeTxHash = '';
  let musdTxHash = '';

  if (!skipFunding) {
    const nativeWei = ethers.parseEther(nativeAmountText);
    if (nativeWei > 0n) {
      const tx = await deployer.sendTransaction({
        to: wallet.address,
        value: nativeWei
      });
      await tx.wait();
      nativeFunded = nativeAmountText;
      nativeTxHash = tx.hash;
    }

    const registry = readRegistry(registryPath);
    const musdAddress = String(registry.contracts?.musd || '').trim();
    if (!ethers.isAddress(musdAddress)) {
      throw new Error(`invalid mUSD address in registry: ${musdAddress || '<empty>'}`);
    }

    const musd = await ethers.getContractAt(MUSD_ABI, musdAddress);
    const decimals = Number(await musd.decimals());
    const musdWei = ethers.parseUnits(musdAmountText, decimals);
    if (musdWei > 0n) {
      const mintTx = await musd.mint(wallet.address, musdWei);
      await mintTx.wait();
      musdFunded = musdAmountText;
      musdTxHash = mintTx.hash;
    }
  }

  const record: BotWalletRecord = {
    label,
    network: network.name,
    chainId,
    address: wallet.address,
    privateKey: wallet.privateKey,
    createdAt: new Date().toISOString(),
    nativeFunded,
    musdFunded,
    nativeTxHash: nativeTxHash || undefined,
    musdTxHash: musdTxHash || undefined
  };

  writeSecrets(secretsPath, record);

  const botEnvPath = join(secretDir, `bot-${label}-${network.name}.env`);
  const botEnv = [
    `BOT_WALLET_LABEL=${label}`,
    `BOT_WALLET_ADDRESS=${wallet.address}`,
    `BOT_PRIVATE_KEY=${wallet.privateKey}`,
    `BOT_NETWORK=${network.name}`
  ].join('\n');
  writeFileSync(botEnvPath, `${botEnv}\n`, 'utf8');
  try {
    chmodSync(botEnvPath, 0o600);
  } catch {
    // permissions are best-effort on non-POSIX filesystems
  }

  console.log(`bot wallet created for network=${network.name}`);
  console.log(`address=${wallet.address}`);
  console.log(`native_funded=${nativeFunded}`);
  console.log(`musd_funded=${musdFunded}`);
  if (nativeTxHash) {
    console.log(`native_tx=${nativeTxHash}`);
  }
  if (musdTxHash) {
    console.log(`musd_tx=${musdTxHash}`);
  }
  console.log(`secret_record=${secretsPath}`);
  console.log(`bot_env=${botEnvPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
