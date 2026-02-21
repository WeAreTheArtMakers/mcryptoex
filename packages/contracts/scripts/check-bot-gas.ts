import { ethers, network } from 'hardhat';

function parseThreshold(): bigint {
  const raw = (process.env.BOT_GAS_GUARD_MIN_NATIVE || '0.03').trim();
  try {
    return ethers.parseEther(raw);
  } catch {
    return ethers.parseEther('0.03');
  }
}

async function main() {
  const [signer] = await ethers.getSigners();
  const wallet = await signer.getAddress();
  const balance = await ethers.provider.getBalance(wallet);
  const threshold = parseThreshold();
  const balanceText = ethers.formatEther(balance);
  const thresholdText = ethers.formatEther(threshold);
  const ok = balance >= threshold;

  console.log(
    `[gas-guard] network=${network.name} wallet=${wallet} balance=${balanceText} threshold=${thresholdText} status=${
      ok ? 'ok' : 'low'
    }`
  );

  if (!ok) {
    process.exitCode = 10;
  }
}

main().catch((error) => {
  console.error(`[gas-guard] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
