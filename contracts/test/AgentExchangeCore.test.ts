import { expect } from 'chai';
import { ethers } from 'hardhat';
import { AgentExchangeCore, MockERC20 } from '../typechain-types';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('AgentExchangeCore', () => {
  let exchange: AgentExchangeCore;
  let usdc: MockERC20;
  let weth: MockERC20;
  let admin: HardhatEthersSigner;
  let trader: HardhatEthersSigner;
  let lp: HardhatEthersSigner;

  let pairId: string;

  const USDC_AMOUNT = ethers.parseUnits('3000', 6);  // 3000 USDC
  const WETH_AMOUNT = ethers.parseUnits('1', 18);    // 1 WETH

  beforeEach(async () => {
    [admin, trader, lp] = await ethers.getSigners();

    const ERC20 = await ethers.getContractFactory('MockERC20');
    usdc = (await ERC20.deploy()) as MockERC20;
    weth = (await ERC20.deploy()) as MockERC20;

    const Exchange = await ethers.getContractFactory('AgentExchangeCore');
    exchange = (await Exchange.deploy(await usdc.getAddress())) as AgentExchangeCore;

    pairId = await exchange.getPairId(await usdc.getAddress(), await weth.getAddress());

    // Mint tokens
    await usdc.mint(trader.address, ethers.parseUnits('10000', 6));
    await weth.mint(trader.address, ethers.parseUnits('10', 18));
    await usdc.mint(lp.address, ethers.parseUnits('100000', 6));
    await weth.mint(lp.address, ethers.parseUnits('100', 18));

    // Approvals
    for (const signer of [trader, lp]) {
      await usdc.connect(signer).approve(await exchange.getAddress(), ethers.MaxUint256);
      await weth.connect(signer).approve(await exchange.getAddress(), ethers.MaxUint256);
    }
  });

  // ── createPair ────────────────────────────────────────────────────────────────

  describe('createPair', () => {
    it('creates a pair and emits PairCreated', async () => {
      await expect(exchange.createPair(await usdc.getAddress(), await weth.getAddress()))
        .to.emit(exchange, 'PairCreated')
        .withArgs(pairId, await usdc.getAddress(), await weth.getAddress());
    });

    it('reverts for duplicate pair', async () => {
      await exchange.createPair(await usdc.getAddress(), await weth.getAddress());
      await expect(exchange.createPair(await usdc.getAddress(), await weth.getAddress()))
        .to.be.revertedWith('Pair exists');
    });

    it('reverts for same token', async () => {
      await expect(exchange.createPair(await usdc.getAddress(), await usdc.getAddress()))
        .to.be.revertedWith('Same tokens');
    });

    it('reverts for non-admin', async () => {
      await expect(exchange.connect(trader).createPair(await usdc.getAddress(), await weth.getAddress()))
        .to.be.revertedWith('Not admin');
    });
  });

  // ── addLiquidity ──────────────────────────────────────────────────────────────

  describe('addLiquidity', () => {
    beforeEach(async () => {
      await exchange.createPair(await usdc.getAddress(), await weth.getAddress());
    });

    it('accepts liquidity and emits LiquidityAdded', async () => {
      await expect(exchange.connect(lp).addLiquidity(pairId, USDC_AMOUNT, WETH_AMOUNT))
        .to.emit(exchange, 'LiquidityAdded')
        .withArgs(pairId, lp.address, USDC_AMOUNT, WETH_AMOUNT);

      const pair = await exchange.getPair(pairId);
      expect(pair.reserve0).to.equal(USDC_AMOUNT);
      expect(pair.reserve1).to.equal(WETH_AMOUNT);
    });

    it('reverts on inactive pair', async () => {
      await exchange.setPairActive(pairId, false);
      await expect(exchange.connect(lp).addLiquidity(pairId, USDC_AMOUNT, WETH_AMOUNT))
        .to.be.revertedWith('Pair not active');
    });
  });

  // ── getAmountOut ──────────────────────────────────────────────────────────────

  describe('getAmountOut', () => {
    it('calculates output with 0.3% fee', () => {
      const amountIn   = ethers.parseUnits('100', 6);  // 100 USDC
      const reserveIn  = ethers.parseUnits('10000', 6);
      const reserveOut = ethers.parseUnits('3', 18);   // 3 WETH

      // amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
      const fee      = amountIn * 997n;
      const num      = fee * reserveOut;
      const denom    = reserveIn * 1000n + fee;
      const expected = num / denom;

      return exchange.getAmountOut(amountIn, reserveIn, reserveOut).then((out: bigint) => {
        expect(out).to.equal(expected);
      });
    });

    it('reverts on zero input', async () => {
      await expect(exchange.getAmountOut(0n, 1000n, 1000n)).to.be.revertedWith('Insufficient input');
    });

    it('reverts on zero reserve', async () => {
      await expect(exchange.getAmountOut(100n, 0n, 1000n)).to.be.revertedWith('Insufficient liquidity');
    });
  });

  // ── executeTrade ──────────────────────────────────────────────────────────────

  describe('executeTrade', () => {
    beforeEach(async () => {
      await exchange.createPair(await usdc.getAddress(), await weth.getAddress());
      // Add 10 WETH and 30000 USDC liquidity (price ~3000 USDC/WETH)
      await exchange.connect(lp).addLiquidity(
        pairId,
        ethers.parseUnits('30000', 6),
        ethers.parseUnits('10', 18)
      );
    });

    it('executes USDC→WETH swap and emits TradeExecuted', async () => {
      const amountIn = ethers.parseUnits('300', 6); // 300 USDC → ~0.1 WETH

      await expect(exchange.connect(trader).executeTrade(pairId, await usdc.getAddress(), amountIn, 0n))
        .to.emit(exchange, 'TradeExecuted');

      expect(await exchange.tradeCount()).to.equal(1n);
    });

    it('slippage check reverts if output is below minimum', async () => {
      const amountIn = ethers.parseUnits('100', 6);
      const highMin = ethers.parseUnits('100', 18); // impossibly high minimum
      await expect(
        exchange.connect(trader).executeTrade(pairId, await usdc.getAddress(), amountIn, highMin)
      ).to.be.revertedWith('Slippage exceeded');
    });

    it('reverts on inactive pair', async () => {
      await exchange.setPairActive(pairId, false);
      await expect(
        exchange.connect(trader).executeTrade(pairId, await usdc.getAddress(), 100n, 0n)
      ).to.be.revertedWith('Pair not active');
    });

    it('reverts for invalid token', async () => {
      await expect(
        exchange.connect(trader).executeTrade(pairId, trader.address, 100n, 0n)
      ).to.be.revertedWith('Invalid token');
    });

    it('updates reserves correctly after trade', async () => {
      const amountIn = ethers.parseUnits('300', 6);
      const reserveBefore = await exchange.getPair(pairId);

      await exchange.connect(trader).executeTrade(pairId, await usdc.getAddress(), amountIn, 0n);

      const reserveAfter = await exchange.getPair(pairId);
      expect(reserveAfter.reserve0).to.equal(reserveBefore.reserve0 + amountIn);
      expect(reserveAfter.reserve1).to.be.lt(reserveBefore.reserve1);
    });
  });

  // ── getTradeHistory ───────────────────────────────────────────────────────────

  describe('getTradeHistory', () => {
    beforeEach(async () => {
      await exchange.createPair(await usdc.getAddress(), await weth.getAddress());
      await exchange.connect(lp).addLiquidity(
        pairId,
        ethers.parseUnits('30000', 6),
        ethers.parseUnits('10', 18)
      );
      // Execute 3 trades
      for (let i = 0; i < 3; i++) {
        await exchange.connect(trader).executeTrade(
          pairId, await usdc.getAddress(), ethers.parseUnits('100', 6), 0n
        );
      }
    });

    it('returns all trades', async () => {
      const history = await exchange.getTradeHistory(pairId, 0n, 10n);
      expect(history.length).to.equal(3);
    });

    it('respects offset and limit', async () => {
      const page = await exchange.getTradeHistory(pairId, 1n, 2n);
      expect(page.length).to.equal(2);
    });

    it('returns empty array for out-of-range offset', async () => {
      const empty = await exchange.getTradeHistory(pairId, 100n, 10n);
      expect(empty.length).to.equal(0);
    });
  });

  // ── admin controls ────────────────────────────────────────────────────────────

  describe('admin controls', () => {
    it('transferAdmin changes admin', async () => {
      await exchange.transferAdmin(trader.address);
      expect(await exchange.admin()).to.equal(trader.address);
    });

    it('old admin loses createPair access after transfer', async () => {
      await exchange.transferAdmin(trader.address);
      await expect(exchange.createPair(await usdc.getAddress(), await weth.getAddress()))
        .to.be.revertedWith('Not admin');
    });

    it('setPairActive deactivates and reactivates a pair', async () => {
      await exchange.createPair(await usdc.getAddress(), await weth.getAddress());
      await exchange.setPairActive(pairId, false);
      expect((await exchange.getPair(pairId)).active).to.be.false;
      await exchange.setPairActive(pairId, true);
      expect((await exchange.getPair(pairId)).active).to.be.true;
    });
  });
});
