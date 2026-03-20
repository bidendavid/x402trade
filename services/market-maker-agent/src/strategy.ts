/**
 * Market Making Strategy
 *
 * Places N levels of limit orders on both sides of the mid price.
 * Each level is spaced by `spread` from the previous one.
 *
 * Example with levels=3, spread=0.2%, midPrice=$2000, orderSize=0.05 ETH:
 *
 *   asks: $2006  $2010  $2014   (sell 0.05 ETH each)
 *         ────── mid $2000 ──────
 *   bids: $1994  $1990  $1986   (buy 0.05 ETH each)
 */
import { config } from './config.js';
import {
  wallet, getTicker, getBalance, getOrders, placeOrder, cancelOrder,
  type OrderResult,
} from './client.js';

let startPrice: number | null = null;

// ── Risk checks ───────────────────────────────────────────────────────────────

async function riskCheck(currentPrice: number): Promise<void> {
  // 1. Price drift check
  if (startPrice !== null) {
    const drift = Math.abs(currentPrice - startPrice) / startPrice * 100;
    if (drift > config.maxPriceDriftPct) {
      throw new Error(
        `STOP: price drifted ${drift.toFixed(1)}% from start ($${startPrice} → $${currentPrice})`
      );
    }
  }

  // 2. Balance check
  const bal = await getBalance();
  const usdc = parseFloat(bal.usdc_balance);
  const eth  = parseFloat(bal.eth_balance);

  if (usdc < config.minUsdcBalance) {
    throw new Error(`STOP: USDC balance $${usdc} below minimum $${config.minUsdcBalance}`);
  }
  if (eth < config.minEthBalance) {
    throw new Error(`STOP: ETH balance ${eth} below minimum ${config.minEthBalance}`);
  }
}

// ── Cancel all open orders ────────────────────────────────────────────────────

async function cancelAllOrders(): Promise<void> {
  const { orders } = await getOrders(config.pair);
  const open = orders.filter(o => o.status === 'pending' || o.status === 'partial');

  if (open.length === 0) return;
  console.log(`  Cancelling ${open.length} existing orders...`);

  for (const o of open) {
    try {
      await cancelOrder(o.order_id);
    } catch (err) {
      console.warn(`  Failed to cancel ${o.order_id}: ${(err as Error).message}`);
    }
  }
}

// ── Place fresh orders ────────────────────────────────────────────────────────

async function placeOrders(midPrice: number): Promise<void> {
  const results: OrderResult[] = [];

  for (let i = 1; i <= config.levels; i++) {
    const offset = config.spread * i;

    // Buy side (bid): below mid price
    const bidPrice = (midPrice * (1 - offset)).toFixed(2);
    try {
      const r = await placeOrder({
        pair:   config.pair,
        side:   'buy',
        type:   'limit',
        amount: config.orderSize.toFixed(6),
        price:  bidPrice,
      });
      results.push(r);
      console.log(`  BUY  ${config.orderSize} @ $${bidPrice}  → ${r.orderId.slice(0, 8)}…`);
    } catch (err) {
      console.warn(`  BUY  @ $${bidPrice} failed: ${(err as Error).message}`);
    }

    // Sell side (ask): above mid price
    const askPrice = (midPrice * (1 + offset)).toFixed(2);
    try {
      const r = await placeOrder({
        pair:   config.pair,
        side:   'sell',
        type:   'limit',
        amount: config.orderSize.toFixed(6),
        price:  askPrice,
      });
      results.push(r);
      console.log(`  SELL ${config.orderSize} @ $${askPrice}  → ${r.orderId.slice(0, 8)}…`);
    } catch (err) {
      console.warn(`  SELL @ $${askPrice} failed: ${(err as Error).message}`);
    }
  }

  console.log(`  Placed ${results.length} orders around $${midPrice}`);
}

// ── Main cycle ────────────────────────────────────────────────────────────────

export async function runCycle(): Promise<void> {
  // 1. Get current price
  const ticker = await getTicker(config.pair);
  const midPrice = parseFloat(ticker.price);
  console.log(`\n[${new Date().toISOString()}] ${config.pair} = $${midPrice}`);

  if (!startPrice) {
    startPrice = midPrice;
    console.log(`  Reference price set: $${startPrice}`);
  }

  // 2. Risk checks
  await riskCheck(midPrice);

  // 3. Cancel old orders
  await cancelAllOrders();

  // 4. Place fresh grid
  await placeOrders(midPrice);

  // 5. Print balance summary
  const bal = await getBalance();
  console.log(`  Balance: $${parseFloat(bal.usdc_balance).toFixed(2)} USDC | ${parseFloat(bal.eth_balance).toFixed(4)} ETH`);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

export async function shutdown(): Promise<void> {
  console.log('\nShutting down — cancelling all open orders...');
  try {
    await cancelAllOrders();
    console.log('All orders cancelled. Goodbye.');
  } catch (err) {
    console.error('Shutdown error:', err);
  }
}

export { wallet };
