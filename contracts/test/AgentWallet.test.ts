import { expect } from 'chai';
import { ethers } from 'hardhat';
import { AgentWallet, MockERC20 } from '../typechain-types';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('AgentWallet', () => {
  let wallet: AgentWallet;
  let usdc: MockERC20;
  let owner: HardhatEthersSigner;
  let agent1: HardhatEthersSigner;
  let agent2: HardhatEthersSigner;

  const MIN_STAKE = ethers.parseUnits('100', 6); // 100 USDC (6 decimals)

  beforeEach(async () => {
    [owner, agent1, agent2] = await ethers.getSigners();

    const USDC = await ethers.getContractFactory('MockERC20');
    usdc = (await USDC.deploy()) as MockERC20;

    const WalletFactory = await ethers.getContractFactory('AgentWallet');
    wallet = (await WalletFactory.deploy(await usdc.getAddress())) as AgentWallet;

    // Fund agents with 1000 USDC each and pre-approve
    for (const signer of [agent1, agent2]) {
      await usdc.mint(signer.address, ethers.parseUnits('1000', 6));
      await usdc.connect(signer).approve(await wallet.getAddress(), ethers.parseUnits('1000', 6));
    }
  });

  // ── register ────────────────────────────────────────────────────────────────

  describe('register', () => {
    it('registers an agent and emits AgentRegistered', async () => {
      await expect(wallet.connect(agent1).register())
        .to.emit(wallet, 'AgentRegistered')
        .withArgs(agent1.address, MIN_STAKE);

      const info = await wallet.getAgent(agent1.address);
      expect(info.active).to.be.true;
      expect(info.stake).to.equal(MIN_STAKE);
      expect(info.score).to.equal(100n);
    });

    it('reverts on double registration', async () => {
      await wallet.connect(agent1).register();
      await expect(wallet.connect(agent1).register()).to.be.revertedWith('Already registered');
    });

    it('increments totalAgents', async () => {
      await wallet.connect(agent1).register();
      await wallet.connect(agent2).register();
      expect(await wallet.totalAgents()).to.equal(2n);
    });

    it('deducts USDC from agent on registration', async () => {
      const before = await usdc.balanceOf(agent1.address);
      await wallet.connect(agent1).register();
      const after = await usdc.balanceOf(agent1.address);
      expect(before - after).to.equal(MIN_STAKE);
    });
  });

  // ── addStake / unstake ───────────────────────────────────────────────────────

  describe('stake management', () => {
    beforeEach(async () => { await wallet.connect(agent1).register(); });

    it('addStake increases agent stake', async () => {
      const extra = ethers.parseUnits('50', 6);
      await wallet.connect(agent1).addStake(extra);
      const info = await wallet.getAgent(agent1.address);
      expect(info.stake).to.equal(MIN_STAKE + extra);
    });

    it('unstake returns tokens and reduces stake', async () => {
      const extra = ethers.parseUnits('50', 6);
      await wallet.connect(agent1).addStake(extra);
      const balBefore = await usdc.balanceOf(agent1.address);
      await wallet.connect(agent1).unstake(extra);
      const balAfter = await usdc.balanceOf(agent1.address);
      expect(balAfter - balBefore).to.equal(extra);
      expect((await wallet.getAgent(agent1.address)).stake).to.equal(MIN_STAKE);
    });

    it('unstake reverts if it would drop below minStake', async () => {
      await expect(wallet.connect(agent1).unstake(ethers.parseUnits('1', 6)))
        .to.be.revertedWith('Below minimum stake');
    });

    it('unstake reverts with zero amount', async () => {
      await expect(wallet.connect(agent1).unstake(0n)).to.be.revertedWith('Zero amount');
    });
  });

  // ── updateScore ──────────────────────────────────────────────────────────────

  describe('updateScore', () => {
    beforeEach(async () => { await wallet.connect(agent1).register(); });

    it('decreases score by delta', async () => {
      await wallet.updateScore(agent1.address, -10n);
      expect((await wallet.getAgent(agent1.address)).score).to.equal(90n);
    });

    it('score is clamped at 100', async () => {
      await wallet.updateScore(agent1.address, 50n);
      expect((await wallet.getAgent(agent1.address)).score).to.equal(100n);
    });

    it('score is clamped at 0', async () => {
      await wallet.updateScore(agent1.address, -200n);
      expect((await wallet.getAgent(agent1.address)).score).to.equal(0n);
    });

    it('emits ScoreUpdated with correct values', async () => {
      await expect(wallet.updateScore(agent1.address, -5n))
        .to.emit(wallet, 'ScoreUpdated')
        .withArgs(agent1.address, 100n, 95n);
    });

    it('reverts for unauthorized caller', async () => {
      await expect(wallet.connect(agent2).updateScore(agent1.address, -5n))
        .to.be.revertedWith('Not authorized');
    });
  });

  // ── blacklist ────────────────────────────────────────────────────────────────

  describe('blacklist', () => {
    beforeEach(async () => { await wallet.connect(agent1).register(); });

    it('blacklists agent, slashes stake, emits event', async () => {
      await expect(wallet.blacklist(agent1.address))
        .to.emit(wallet, 'AgentBlacklisted')
        .withArgs(agent1.address, MIN_STAKE);

      expect(await wallet.blacklisted(agent1.address)).to.be.true;
      expect((await wallet.getAgent(agent1.address)).active).to.be.false;
      expect((await wallet.getAgent(agent1.address)).stake).to.equal(0n);
    });

    it('slashed stake goes to owner', async () => {
      const ownerBefore = await usdc.balanceOf(owner.address);
      await wallet.blacklist(agent1.address);
      const ownerAfter = await usdc.balanceOf(owner.address);
      expect(ownerAfter - ownerBefore).to.equal(MIN_STAKE);
    });

    it('reverts double blacklisting', async () => {
      await wallet.blacklist(agent1.address);
      // After blacklisting, agent is no longer active; contract checks "Not active" first
      await expect(wallet.blacklist(agent1.address)).to.be.reverted;
    });

    it('reverts if non-owner tries to blacklist', async () => {
      await expect(wallet.connect(agent1).blacklist(agent2.address)).to.be.reverted;
    });
  });

  // ── deactivate ───────────────────────────────────────────────────────────────

  describe('deactivate', () => {
    beforeEach(async () => { await wallet.connect(agent1).register(); });

    it('returns stake and marks agent inactive', async () => {
      const balBefore = await usdc.balanceOf(agent1.address);
      await expect(wallet.connect(agent1).deactivate())
        .to.emit(wallet, 'AgentDeactivated')
        .withArgs(agent1.address);

      const info = await wallet.getAgent(agent1.address);
      expect(info.active).to.be.false;
      expect(info.stake).to.equal(0n);
      expect(await usdc.balanceOf(agent1.address) - balBefore).to.equal(MIN_STAKE);
    });

    it('decrements totalAgents', async () => {
      await wallet.connect(agent1).deactivate();
      expect(await wallet.totalAgents()).to.equal(0n);
    });
  });

  // ── isActiveAgent ────────────────────────────────────────────────────────────

  describe('isActiveAgent', () => {
    it('returns false for unregistered address', async () => {
      expect(await wallet.isActiveAgent(agent1.address)).to.be.false;
    });

    it('returns true after registration', async () => {
      await wallet.connect(agent1).register();
      expect(await wallet.isActiveAgent(agent1.address)).to.be.true;
    });

    it('returns false after blacklisting', async () => {
      await wallet.connect(agent1).register();
      await wallet.blacklist(agent1.address);
      expect(await wallet.isActiveAgent(agent1.address)).to.be.false;
    });

    it('returns false after deactivation', async () => {
      await wallet.connect(agent1).register();
      await wallet.connect(agent1).deactivate();
      expect(await wallet.isActiveAgent(agent1.address)).to.be.false;
    });
  });
});
