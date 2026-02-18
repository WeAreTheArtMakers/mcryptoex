import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('Harmony Engine (Factory/Pair/Router)', function () {
  async function deployFixture() {
    const [admin, lp, trader] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory('MockERC20');
    const tokenA = await MockERC20.deploy('Token A', 'TKNA', 18);
    const tokenB = await MockERC20.deploy('Token B', 'TKNB', 18);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    const HarmonyFactory = await ethers.getContractFactory('HarmonyFactory');
    const factory = await HarmonyFactory.deploy(admin.address);
    await factory.waitForDeployment();

    const HarmonyRouter = await ethers.getContractFactory('HarmonyRouter');
    const router = await HarmonyRouter.deploy(await factory.getAddress());
    await router.waitForDeployment();

    await (await tokenA.mint(lp.address, ethers.parseEther('5000'))).wait();
    await (await tokenB.mint(lp.address, ethers.parseEther('5000'))).wait();
    await (await tokenA.mint(trader.address, ethers.parseEther('500'))).wait();

    return { admin, lp, trader, tokenA, tokenB, factory, router };
  }

  it('creates pair, adds liquidity, swaps, and removes liquidity', async function () {
    const { lp, trader, tokenA, tokenB, factory, router } = await deployFixture();

    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);

    await (await tokenA.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await tokenB.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();

    await expect(
      router
        .connect(lp)
        .addLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          ethers.parseEther('1000'),
          ethers.parseEther('1000'),
          0,
          0,
          lp.address,
          deadline
        )
    ).to.emit(router, 'NoteLiquidityAdded');

    const pairAddress = await factory.getPair(await tokenA.getAddress(), await tokenB.getAddress());
    expect(pairAddress).to.not.equal(ethers.ZeroAddress);

    const pair = await ethers.getContractAt('HarmonyPair', pairAddress);
    expect(await pair.totalSupply()).to.be.greaterThan(0n);

    await (await tokenA.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();

    await expect(
      router
        .connect(trader)
        .swapExactTokensForTokens(
          ethers.parseEther('10'),
          0,
          [await tokenA.getAddress(), await tokenB.getAddress()],
          trader.address,
          deadline
        )
    )
      .to.emit(router, 'NoteSwap')
      .and.to.emit(pair, 'Swap');

    const traderTokenB = await tokenB.balanceOf(trader.address);
    expect(traderTokenB).to.be.greaterThan(0n);

    const lpBalance = await pair.balanceOf(lp.address);
    await (await pair.connect(lp).approve(await router.getAddress(), lpBalance)).wait();

    await expect(
      router
        .connect(lp)
        .removeLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          lpBalance / 2n,
          0,
          0,
          lp.address,
          deadline
        )
    ).to.emit(router, 'NoteLiquidityRemoved');
  });

  it('blocks pair operations when the factory is paused', async function () {
    const { admin, lp, trader, tokenA, tokenB, factory, router } = await deployFixture();

    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);

    await (await tokenA.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await tokenB.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await tokenA.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();

    await (
      await router
        .connect(lp)
        .addLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          ethers.parseEther('1000'),
          ethers.parseEther('1000'),
          0,
          0,
          lp.address,
          deadline
        )
    ).wait();

    const pairAddress = await factory.getPair(await tokenA.getAddress(), await tokenB.getAddress());
    const pair = await ethers.getContractAt('HarmonyPair', pairAddress);

    await (await factory.connect(admin).pause()).wait();

    await expect(
      router
        .connect(trader)
        .swapExactTokensForTokens(
          ethers.parseEther('1'),
          0,
          [await tokenA.getAddress(), await tokenB.getAddress()],
          trader.address,
          deadline
        )
    ).to.be.revertedWithCustomError(pair, 'EnginePaused');
  });

  it('blocks router state-changing operations when router is paused', async function () {
    const { admin, lp, tokenA, tokenB, router } = await deployFixture();

    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    await (await tokenA.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await tokenB.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();

    await (await router.connect(admin).pause()).wait();

    await expect(
      router
        .connect(lp)
        .addLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          ethers.parseEther('10'),
          ethers.parseEther('10'),
          0,
          0,
          lp.address,
          deadline
        )
    ).to.be.revertedWithCustomError(router, 'EnforcedPause');
  });

  it('enforces path-length guardrails and owner controls for routing', async function () {
    const { admin, lp, trader, tokenA, tokenB, router } = await deployFixture();

    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    await (await tokenA.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await tokenB.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await tokenA.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();

    await expect(
      router.connect(trader).setMaxPathLength(2)
    ).to.be.revertedWithCustomError(router, 'OwnableUnauthorizedAccount');

    await (await router.connect(admin).setMaxPathLength(2)).wait();
    expect(await router.maxPathLength()).to.equal(2);

    await expect(
      router
        .connect(trader)
        .swapExactTokensForTokens(
          ethers.parseEther('1'),
          0,
          [await tokenA.getAddress(), await tokenB.getAddress(), await tokenA.getAddress()],
          trader.address,
          deadline
        )
    ).to.be.revertedWithCustomError(router, 'InvalidPathLength');
  });
});
