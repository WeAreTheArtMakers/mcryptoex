import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('Performance Check - local end-to-end swap', function () {
  it('executes local swap and verifies events + gas profile', async function () {
    const [admin, lp, trader] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory('MockERC20');
    const tokenA = await MockERC20.deploy('Perf Token A', 'PFA', 18);
    const tokenB = await MockERC20.deploy('Perf Token B', 'PFB', 18);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    const HarmonyFactory = await ethers.getContractFactory('HarmonyFactory');
    const factory = await HarmonyFactory.deploy(admin.address);
    await factory.waitForDeployment();

    const HarmonyRouter = await ethers.getContractFactory('HarmonyRouter');
    const router = await HarmonyRouter.deploy(await factory.getAddress());
    await router.waitForDeployment();

    await (await tokenA.mint(lp.address, ethers.parseEther('10000'))).wait();
    await (await tokenB.mint(lp.address, ethers.parseEther('10000'))).wait();
    await (await tokenA.mint(trader.address, ethers.parseEther('1000'))).wait();

    await (await tokenA.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await tokenB.connect(lp).approve(await router.getAddress(), ethers.MaxUint256)).wait();

    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);

    await (
      await router
        .connect(lp)
        .addLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          ethers.parseEther('2000'),
          ethers.parseEther('2000'),
          0,
          0,
          lp.address,
          deadline
        )
    ).wait();

    const pairAddress = await factory.getPair(await tokenA.getAddress(), await tokenB.getAddress());
    const pair = await ethers.getContractAt('HarmonyPair', pairAddress);

    await (await tokenA.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();

    const tx = await router
      .connect(trader)
      .swapExactTokensForTokens(
        ethers.parseEther('50'),
        0,
        [await tokenA.getAddress(), await tokenB.getAddress()],
        trader.address,
        deadline
      );

    await expect(tx).to.emit(router, 'NoteSwap');
    await expect(tx).to.emit(pair, 'Swap');

    const receipt = await tx.wait();
    const gasUsed = receipt?.gasUsed ?? 0n;

    console.log(`local_swap_gas_used=${gasUsed.toString()}`);
    expect(gasUsed).to.be.greaterThan(0n);
    expect(gasUsed).to.be.lessThan(350_000n);
  });
});
