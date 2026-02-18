import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('mUSD + Stabilizer', function () {
  async function deployFixture() {
    const [admin, alice, bob] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory('MockERC20');
    const usdc = await MockERC20.deploy('USD Coin', 'USDC', 6);
    await usdc.waitForDeployment();

    const MUSDToken = await ethers.getContractFactory('MUSDToken');
    const musd = await MUSDToken.deploy(admin.address);
    await musd.waitForDeployment();

    const MockPriceOracle = await ethers.getContractFactory('MockPriceOracle');
    const oracle = await MockPriceOracle.deploy(admin.address);
    await oracle.waitForDeployment();

    const Stabilizer = await ethers.getContractFactory('Stabilizer');
    const stabilizer = await Stabilizer.deploy(await musd.getAddress(), await oracle.getAddress(), admin.address);
    await stabilizer.waitForDeployment();

    const minterRole = await musd.MINTER_ROLE();
    await (await musd.grantRole(minterRole, await stabilizer.getAddress())).wait();

    await (
      await oracle.setPrice(await usdc.getAddress(), ethers.parseEther('1'))
    ).wait();

    await (
      await stabilizer.configureCollateral(
        await usdc.getAddress(),
        true,
        ethers.parseEther('0.5'),
        ethers.parseEther('2')
      )
    ).wait();

    await (await usdc.mint(alice.address, 2_000_000000n)).wait();
    await (await usdc.mint(bob.address, 2_000_000000n)).wait();

    return { admin, alice, bob, usdc, musd, oracle, stabilizer };
  }

  it('mints mUSD from collateral and emits NoteMinted', async function () {
    const { alice, usdc, musd, stabilizer } = await deployFixture();

    const collateralIn = 1_000_000000n;
    await (await usdc.connect(alice).approve(await stabilizer.getAddress(), collateralIn)).wait();

    await expect(
      stabilizer
        .connect(alice)
        .mintWithCollateral(await usdc.getAddress(), collateralIn, 0n, alice.address)
    ).to.emit(stabilizer, 'NoteMinted');

    const minted = await musd.balanceOf(alice.address);
    expect(minted).to.be.greaterThan(ethers.parseEther('909'));
    expect(minted).to.be.lessThan(ethers.parseEther('910'));
  });

  it('enforces max mint per block circuit', async function () {
    const { alice, usdc, stabilizer } = await deployFixture();

    await (await stabilizer.setMaxMintPerBlock(ethers.parseEther('100'))).wait();

    const collateralIn = 1_000_000000n;
    await (await usdc.connect(alice).approve(await stabilizer.getAddress(), collateralIn)).wait();

    await expect(
      stabilizer
        .connect(alice)
        .mintWithCollateral(await usdc.getAddress(), collateralIn, 0n, alice.address)
    ).to.be.revertedWithCustomError(stabilizer, 'MintLimitExceeded');
  });

  it('rejects stale oracle data', async function () {
    const { admin, alice, usdc, oracle, stabilizer } = await deployFixture();

    await (await stabilizer.setOracleStalenessThreshold(60)).wait();
    const latestBlock = await ethers.provider.getBlock('latest');
    const staleTs = BigInt((latestBlock?.timestamp ?? 0) - 500);

    await (
      await oracle
        .connect(admin)
        .setPriceWithTimestamp(await usdc.getAddress(), ethers.parseEther('1'), staleTs)
    ).wait();

    const collateralIn = 100_000000n;
    await (await usdc.connect(alice).approve(await stabilizer.getAddress(), collateralIn)).wait();

    await expect(
      stabilizer
        .connect(alice)
        .mintWithCollateral(await usdc.getAddress(), collateralIn, 0n, alice.address)
    ).to.be.revertedWithCustomError(stabilizer, 'OracleDataStale');
  });

  it('burns mUSD for collateral and emits NoteBurned', async function () {
    const { alice, usdc, musd, stabilizer } = await deployFixture();

    const collateralIn = 1_000_000000n;
    await (await usdc.connect(alice).approve(await stabilizer.getAddress(), collateralIn)).wait();
    await (
      await stabilizer
        .connect(alice)
        .mintWithCollateral(await usdc.getAddress(), collateralIn, 0n, alice.address)
    ).wait();

    const minted = await musd.balanceOf(alice.address);
    const burnAmount = minted / 2n;

    const usdcBefore = await usdc.balanceOf(alice.address);
    await (await musd.connect(alice).approve(await stabilizer.getAddress(), burnAmount)).wait();

    await expect(
      stabilizer
        .connect(alice)
        .burnForCollateral(await usdc.getAddress(), burnAmount, 0n, alice.address)
    ).to.emit(stabilizer, 'NoteBurned');

    const usdcAfter = await usdc.balanceOf(alice.address);
    expect(usdcAfter).to.be.greaterThan(usdcBefore);
  });

  it('trips circuit breaker when collateral ratio falls below emergency threshold', async function () {
    const { admin, alice, usdc, stabilizer } = await deployFixture();

    const collateralIn = 1_000_000000n;
    await (await usdc.connect(alice).approve(await stabilizer.getAddress(), collateralIn)).wait();
    await (
      await stabilizer
        .connect(alice)
        .mintWithCollateral(await usdc.getAddress(), collateralIn, 0n, alice.address)
    ).wait();

    await (await stabilizer.connect(admin).setCollateralRatios(13_000, 12_000)).wait();

    await expect(stabilizer.connect(admin).checkAndTripCircuitBreaker())
      .to.emit(stabilizer, 'CircuitBreakerTripped');

    expect(await stabilizer.circuitBreakerTripped()).to.equal(true);
    expect(await stabilizer.paused()).to.equal(true);
  });
});
