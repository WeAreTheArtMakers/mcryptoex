import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('Resonance Vault (Treasury)', function () {
  async function deployFixture() {
    const [admin, lp, trader, keeper, ops, incentives, reserve] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory('MockERC20');
    const tokenA = await MockERC20.deploy('Token A', 'TKNA', 18);
    await tokenA.waitForDeployment();

    const MUSDToken = await ethers.getContractFactory('MUSDToken');
    const musd = await MUSDToken.deploy(admin.address);
    await musd.waitForDeployment();

    const HarmonyFactory = await ethers.getContractFactory('HarmonyFactory');
    const factory = await HarmonyFactory.deploy(admin.address);
    await factory.waitForDeployment();

    const HarmonyRouter = await ethers.getContractFactory('HarmonyRouter');
    const router = await HarmonyRouter.deploy(await factory.getAddress());
    await router.waitForDeployment();

    const ResonanceVault = await ethers.getContractFactory('ResonanceVault');
    const vault = await ResonanceVault.deploy(
      await router.getAddress(),
      await musd.getAddress(),
      await factory.getAddress(),
      admin.address
    );
    await vault.waitForDeployment();

    await (await factory.connect(admin).setFeeParams(30, 5)).wait();
    await (await factory.connect(admin).setTreasury(await vault.getAddress())).wait();
    await (await vault.connect(admin).setTokenAllowlist(await tokenA.getAddress(), true)).wait();
    await (
      await vault
        .connect(admin)
        .setDistributionConfig(ops.address, incentives.address, reserve.address, 4_000, 4_000, 2_000)
    ).wait();

    await (await tokenA.mint(lp.address, ethers.parseEther('5000'))).wait();
    await (await tokenA.mint(trader.address, ethers.parseEther('500'))).wait();
    await (await musd.connect(admin).mint(lp.address, ethers.parseEther('5000'))).wait();

    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    await (await tokenA.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await musd.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();

    await (
      await router
        .connect(lp)
        .addLiquidity(
          await tokenA.getAddress(),
          await musd.getAddress(),
          ethers.parseEther('1000'),
          ethers.parseEther('1000'),
          0,
          0,
          lp.address,
          deadline
        )
    ).wait();

    return { admin, lp, trader, keeper, ops, incentives, reserve, tokenA, musd, factory, router, vault };
  }

  it('receives protocol fees and converts to mUSD via permissionless harvest', async function () {
    const { trader, keeper, tokenA, musd, factory, router, vault } = await deployFixture();

    const pairAddress = await factory.getPair(await tokenA.getAddress(), await musd.getAddress());
    const pair = await ethers.getContractAt('HarmonyPair', pairAddress);

    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    await (await tokenA.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();

    const swapTx = await router
      .connect(trader)
      .swapExactTokensForTokens(
        ethers.parseEther('10'),
        0,
        [await tokenA.getAddress(), await musd.getAddress()],
        trader.address,
        deadline
      );
    const swapReceipt = await swapTx.wait();

    const feeEvent = swapReceipt?.logs
      .map((log) => {
        try {
          return pair.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event) => event?.name === 'ProtocolFeeAccrued');

    expect(feeEvent).to.not.equal(undefined);
    expect(feeEvent).to.not.equal(null);

    const accrued = await tokenA.balanceOf(await vault.getAddress());
    expect(accrued).to.be.greaterThan(0n);

    const quote = await router.getAmountsOut(accrued, [await tokenA.getAddress(), await musd.getAddress()]);
    const minOut = (quote[quote.length - 1] * 99n) / 100n;

    const keeperBefore = await musd.balanceOf(keeper.address);
    await (
      await vault
        .connect(keeper)
        .harvestAndConvert(
          await tokenA.getAddress(),
          accrued,
          minOut,
          BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600),
          [await tokenA.getAddress(), await musd.getAddress()]
        )
    ).wait();
    const keeperAfter = await musd.balanceOf(keeper.address);
    expect(keeperAfter).to.be.greaterThan(keeperBefore);
    const tokenAAfter = await tokenA.balanceOf(await vault.getAddress());
    expect(tokenAAfter).to.be.lessThan(accrued);
    expect(tokenAAfter).to.be.lte((accrued * 5n) / 10_000n + 1n);
  });

  it('enforces allowlist, pause, and slippage guardrails', async function () {
    const { admin, keeper, tokenA, musd, router, vault } = await deployFixture();

    await (await tokenA.mint(await vault.getAddress(), ethers.parseEther('5'))).wait();

    const amountIn = ethers.parseEther('1');
    const path = [await tokenA.getAddress(), await musd.getAddress()];
    const quote = await router.getAmountsOut(amountIn, path);

    await (await vault.connect(admin).setTokenAllowlist(await tokenA.getAddress(), false)).wait();
    await expect(
      vault.connect(keeper).harvestAndConvert(
        await tokenA.getAddress(),
        amountIn,
        (quote[quote.length - 1] * 99n) / 100n,
        BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600),
        path
      )
    ).to.be.revertedWithCustomError(vault, 'TokenNotAllowed');

    await (await vault.connect(admin).setTokenAllowlist(await tokenA.getAddress(), true)).wait();
    await expect(
      vault.connect(keeper).harvestAndConvert(
        await tokenA.getAddress(),
        amountIn,
        (quote[quote.length - 1] * 90n) / 100n,
        BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600),
        path
      )
    ).to.be.revertedWithCustomError(vault, 'SlippageLimitExceeded');

    await (await vault.connect(admin).pause()).wait();
    await expect(
      vault.connect(keeper).harvestAndConvert(
        await tokenA.getAddress(),
        amountIn,
        (quote[quote.length - 1] * 99n) / 100n,
        BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600),
        path
      )
    ).to.be.revertedWithCustomError(vault, 'EnforcedPause');
  });

  it('distributes mUSD to configured revenue buckets', async function () {
    const { ops, incentives, reserve, musd, vault } = await deployFixture();

    const distributionAmount = ethers.parseEther('100');
    await (await musd.mint(await vault.getAddress(), distributionAmount)).wait();

    const opsBefore = await musd.balanceOf(ops.address);
    const incentivesBefore = await musd.balanceOf(incentives.address);
    const reserveBefore = await musd.balanceOf(reserve.address);

    await (await vault.distributeMusd(distributionAmount)).wait();

    const opsAfter = await musd.balanceOf(ops.address);
    const incentivesAfter = await musd.balanceOf(incentives.address);
    const reserveAfter = await musd.balanceOf(reserve.address);

    expect(opsAfter - opsBefore).to.equal(ethers.parseEther('40'));
    expect(incentivesAfter - incentivesBefore).to.equal(ethers.parseEther('40'));
    expect(reserveAfter - reserveBefore).to.equal(ethers.parseEther('20'));
  });
});
