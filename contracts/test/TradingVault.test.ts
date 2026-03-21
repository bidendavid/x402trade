import { ethers } from 'hardhat';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { TradingVault } from '../typechain-types';

// Minimal ERC-20 mock for testing
const ERC20_MOCK_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function mint(address to, uint256 amount)',
];

const USDC_DECIMALS = 6n;
const toUsdc = (n: number) => BigInt(n) * 10n ** USDC_DECIMALS;
const toEth  = (n: string)  => ethers.parseEther(n);

describe('TradingVault', () => {
  let owner: SignerWithAddress;
  let backend: SignerWithAddress;
  let feeWallet: SignerWithAddress;
  let buyer: SignerWithAddress;
  let seller: SignerWithAddress;
  let other: SignerWithAddress;

  let usdc: any;
  let vault: TradingVault;

  beforeEach(async () => {
    [owner, backend, feeWallet, buyer, seller, other] = await ethers.getSigners();

    // Deploy mock USDC
    const MockERC20 = await ethers.getContractFactory('MockERC20');
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    // Mint USDC to buyer
    await usdc.mint(buyer.address, toUsdc(10_000));

    // Deploy vault
    const Vault = await ethers.getContractFactory('TradingVault');
    vault = await Vault.deploy(
      await usdc.getAddress(),
      backend.address,
      feeWallet.address,
    ) as TradingVault;
    await vault.waitForDeployment();
  });

  // ── Deposits ────────────────────────────────────────────────────────────────

  it('accepts USDC deposit', async () => {
    await usdc.connect(buyer).approve(await vault.getAddress(), toUsdc(1000));
    await vault.connect(buyer).depositUsdc(toUsdc(1000));
    expect(await vault.usdcBalance(buyer.address)).to.equal(toUsdc(1000));
  });

  it('accepts ETH deposit', async () => {
    await vault.connect(seller).depositEth({ value: toEth('1') });
    expect(await vault.ethBalance(seller.address)).to.equal(toEth('1'));
  });

  it('rejects zero USDC deposit', async () => {
    await expect(vault.connect(buyer).depositUsdc(0)).to.be.revertedWith('Zero amount');
  });

  // ── Withdrawals ─────────────────────────────────────────────────────────────

  it('allows USDC withdrawal by user directly', async () => {
    await usdc.connect(buyer).approve(await vault.getAddress(), toUsdc(500));
    await vault.connect(buyer).depositUsdc(toUsdc(500));
    await vault.connect(buyer).withdrawUsdc(toUsdc(200));
    expect(await vault.usdcBalance(buyer.address)).to.equal(toUsdc(300));
  });

  it('allows ETH withdrawal by user directly', async () => {
    await vault.connect(seller).depositEth({ value: toEth('2') });
    await vault.connect(seller).withdrawEth(toEth('0.5'));
    expect(await vault.ethBalance(seller.address)).to.equal(toEth('1.5'));
  });

  it('reverts withdrawal above balance', async () => {
    await expect(vault.connect(buyer).withdrawUsdc(toUsdc(1))).to.be.revertedWith('Insufficient USDC');
  });

  // ── Settlement ──────────────────────────────────────────────────────────────

  async function fundAndSettle() {
    // Fund buyer with USDC
    await usdc.connect(buyer).approve(await vault.getAddress(), toUsdc(2100));
    await vault.connect(buyer).depositUsdc(toUsdc(2100));

    // Fund seller with ETH
    await vault.connect(seller).depositEth({ value: toEth('1') });

    // ETH price = 2000 USDC, buy 0.5 ETH
    const usdcAmount = toUsdc(1000);
    const ethAmount  = toEth('0.5');

    await vault.connect(backend).settle(
      buyer.address,
      seller.address,
      usdcAmount,
      ethAmount,
    );
    return { usdcAmount, ethAmount };
  }

  it('settles trade: moves USDC buyer→seller, ETH seller→buyer', async () => {
    await fundAndSettle();

    // fee = 0.10% of 1000 USDC = 1 USDC
    // buyer paid 1001 USDC total
    expect(await vault.usdcBalance(buyer.address)).to.equal(toUsdc(2100) - toUsdc(1001));
    expect(await vault.usdcBalance(seller.address)).to.equal(toUsdc(1000));
    expect(await vault.usdcBalance(feeWallet.address)).to.equal(toUsdc(1));

    expect(await vault.ethBalance(seller.address)).to.equal(toEth('0.5'));
    expect(await vault.ethBalance(buyer.address)).to.equal(toEth('0.5'));
  });

  it('rejects settlement from non-backend', async () => {
    await expect(
      vault.connect(other).settle(buyer.address, seller.address, toUsdc(100), toEth('0.05'))
    ).to.be.revertedWith('TradingVault: not exchange');
  });

  it('rejects settlement when buyer has insufficient USDC', async () => {
    await vault.connect(seller).depositEth({ value: toEth('1') });
    await expect(
      vault.connect(backend).settle(buyer.address, seller.address, toUsdc(100), toEth('0.05'))
    ).to.be.revertedWith('Buyer: insufficient USDC');
  });

  it('rejects self-trade', async () => {
    await expect(
      vault.connect(backend).settle(buyer.address, buyer.address, toUsdc(100), toEth('0.05'))
    ).to.be.revertedWith('Self-trade');
  });

  // ── Admin ────────────────────────────────────────────────────────────────────

  it('owner can rotate exchange backend', async () => {
    await vault.connect(owner).setExchangeBackend(other.address);
    expect(await vault.exchangeBackend()).to.equal(other.address);
  });

  it('non-owner cannot rotate backend', async () => {
    await expect(vault.connect(buyer).setExchangeBackend(other.address))
      .to.be.revertedWithCustomError(vault, 'OwnableUnauthorizedAccount');
  });

  it('owner can change fee bps', async () => {
    await vault.connect(owner).setFeeBps(20);
    expect(await vault.feeBps()).to.equal(20n);
  });

  it('rejects fee above 100 bps', async () => {
    await expect(vault.connect(owner).setFeeBps(101)).to.be.revertedWith('Fee too high');
  });

  // ── balanceOf view ──────────────────────────────────────────────────────────

  it('balanceOf returns both balances', async () => {
    await usdc.connect(buyer).approve(await vault.getAddress(), toUsdc(500));
    await vault.connect(buyer).depositUsdc(toUsdc(500));
    await vault.connect(buyer).depositEth({ value: toEth('1') });

    const [u, e] = await vault.balanceOf(buyer.address);
    expect(u).to.equal(toUsdc(500));
    expect(e).to.equal(toEth('1'));
  });
});
