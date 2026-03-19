import { randomUUID } from 'crypto';
import { connect, NatsConnection, StringCodec } from 'nats';
import { Order, Trade, OrderResult } from '../types';
import { addToBook, removeFromBook, updateOrderStatus, getBestAsks, getBestBids, updatePriceCache } from './book';
import { getPool } from '../lib/db';
import { lockForBuy, lockForSell, unlockForCancel } from '../lib/balance';

const FEE_RATE = 0.003; // 0.3%
const sc = StringCodec();
let nc: NatsConnection | null = null;

async function getNats(): Promise<NatsConnection> {
  if (!nc || nc.isClosed()) {
    nc = await connect({ servers: process.env.NATS_URL || 'nats://localhost:4222' });
  }
  return nc;
}

async function upsertAgent(walletAddress: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO agents (wallet_address, score, is_active, is_blacklisted)
     VALUES ($1, 100, true, false)
     ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
     RETURNING id`,
    [walletAddress.toLowerCase()]
  );
  return result.rows[0].id as number;
}

async function persistOrder(order: Order, agentId: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO orders
       (order_id, agent_id, pair, side, order_type, amount, price, filled_amount, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0))
     ON CONFLICT (order_id) DO UPDATE
       SET filled_amount = $8, status = $9, updated_at = NOW()`,
    [order.orderId, agentId, order.pair, order.side, order.type,
     order.amount, order.price, order.filledAmount, order.status, order.timestamp]
  );
}

async function persistTrade(trade: Trade, agentId: number, side: 'buy' | 'sell', orderId: string): Promise<void> {
  const pool = getPool();
  const tradeId = side === 'sell' ? `${trade.tradeId}-sell` : trade.tradeId;
  await pool.query(
    `INSERT INTO trades (trade_id, agent_id, order_id, pair, side, amount, price, fee_usdc, gas_used)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)
     ON CONFLICT (trade_id) DO NOTHING`,
    [tradeId, agentId, orderId, trade.pair, side,
     trade.amount, trade.price, (parseFloat(trade.fee) / 2).toFixed(6)]
  );
}

export async function matchOrder(incoming: Order): Promise<OrderResult> {
  const trades: Trade[] = [];
  let remaining = parseFloat(incoming.amount);
  let totalFilled = 0;
  let totalValue = 0;

  const incomingAgentId = await upsertAgent(incoming.agentWallet);

  // Track what we locked so we can unlock excess on partial market fills
  let lockedUsdc = '0';
  let lockedEth = '0';

  // Lock funds before any fills — applies to both limit and market orders
  if (incoming.side === 'buy') {
    let lockPrice: string;
    if (incoming.type === 'limit') {
      lockPrice = incoming.price;
    } else {
      // Market buy: lock at worst-case ask (first ask in book)
      const topAsks = await getBestAsks(incoming.pair, 1);
      if (topAsks.length === 0) {
        incoming.status = 'cancelled';
        await persistOrder(incoming, incomingAgentId);
        return { orderId: incoming.orderId, status: 'cancelled', filledAmount: '0', avgPrice: '0', trades: [] };
      }
      lockPrice = topAsks[0].price;
    }
    lockedUsdc = (parseFloat(incoming.amount) * parseFloat(lockPrice)).toFixed(6);
    await lockForBuy(incoming.agentWallet, lockedUsdc);
  } else {
    // Sell (limit or market): lock the ETH amount
    lockedEth = incoming.amount;
    await lockForSell(incoming.agentWallet, incoming.amount);
  }

  // Persist incoming order first so trades can reference its order_id via FK
  await persistOrder(incoming, incomingAgentId);

  const restingOrders = incoming.side === 'buy'
    ? await getBestAsks(incoming.pair, 50)
    : await getBestBids(incoming.pair, 50);

  for (const resting of restingOrders) {
    if (remaining <= 1e-9) break;

    const restingPrice = parseFloat(resting.price);
    const incomingPrice = parseFloat(incoming.price);

    // Price crossing check for limit orders
    if (incoming.type === 'limit') {
      if (incoming.side === 'buy'  && restingPrice > incomingPrice) break;
      if (incoming.side === 'sell' && restingPrice < incomingPrice) break;
    }

    const restingFilled = parseFloat(resting.filledAmount || '0');
    const restingRemaining = parseFloat(resting.amount) - restingFilled;
    if (restingRemaining <= 1e-9) continue;

    const tradeAmt = Math.min(remaining, restingRemaining);
    const execPrice = restingPrice;
    const usdcTotal = (tradeAmt * execPrice).toFixed(6);
    const fee = (parseFloat(usdcTotal) * FEE_RATE).toFixed(6);

    const trade: Trade = {
      tradeId: randomUUID(),
      pair: incoming.pair,
      buyOrderId:  incoming.side === 'buy'  ? incoming.orderId : resting.orderId,
      sellOrderId: incoming.side === 'sell' ? incoming.orderId : resting.orderId,
      buyerWallet:  incoming.side === 'buy'  ? incoming.agentWallet : resting.agentWallet,
      sellerWallet: incoming.side === 'sell' ? incoming.agentWallet : resting.agentWallet,
      amount: tradeAmt.toFixed(6),
      price: execPrice.toFixed(18),
      usdcTotal,
      fee,
      timestamp: Date.now(),
    };
    trades.push(trade);

    // Update resting order
    const newFilled = (restingFilled + tradeAmt).toFixed(6);
    resting.filledAmount = newFilled;
    resting.status = parseFloat(newFilled) >= parseFloat(resting.amount) ? 'filled' : 'partial';

    if (resting.status === 'filled') {
      await removeFromBook(resting);
    } else {
      await updateOrderStatus(resting);
    }

    const restingAgentId = await upsertAgent(resting.agentWallet);
    await persistOrder(resting, restingAgentId);
    await persistTrade(trade, incomingAgentId,  incoming.side === 'buy'  ? 'buy'  : 'sell', incoming.orderId);
    await persistTrade(trade, restingAgentId,   incoming.side === 'buy'  ? 'sell' : 'buy',  resting.orderId);

    await updatePriceCache(incoming.pair, execPrice.toFixed(18), tradeAmt.toFixed(6));

    // Notify wallet-service via NATS
    try {
      const natsConn = await getNats();
      natsConn.publish('trades.filled', sc.encode(JSON.stringify(trade)));
    } catch (err) {
      console.error('Failed to publish trades.filled:', err);
    }

    remaining   -= tradeAmt;
    totalFilled += tradeAmt;
    totalValue  += tradeAmt * execPrice;
  }

  // Update incoming order state
  incoming.filledAmount = totalFilled.toFixed(6);

  if (incoming.type === 'market') {
    // Market orders always terminate after one pass — they never rest in the book
    incoming.status = remaining <= 1e-9 ? 'filled' : (totalFilled > 0 ? 'partial' : 'cancelled');

    // Unlock over-locked funds for unfilled portion
    if (remaining > 1e-9) {
      if (incoming.side === 'buy' && parseFloat(lockedUsdc) > 0) {
        // Unlock excess USDC: locked at worst-case price, actual cost = totalValue
        const excessUsdc = parseFloat(lockedUsdc) - totalValue;
        if (excessUsdc > 1e-9) {
          await unlockForCancel(incoming.agentWallet, excessUsdc.toFixed(6), '0');
        }
      } else if (incoming.side === 'sell') {
        // Unlock unfilled ETH amount
        await unlockForCancel(incoming.agentWallet, '0', remaining.toFixed(6));
      }
    }
  } else {
    // Limit order: unfilled portion rests in book
    incoming.status =
      remaining <= 1e-9 ? 'filled' :
      totalFilled > 0   ? 'partial' :
                          'pending';

    if (remaining > 1e-9) {
      await addToBook(incoming);
    }
  }

  // Update incoming order final state in DB
  await persistOrder(incoming, incomingAgentId);

  const avgPrice = totalFilled > 0 ? (totalValue / totalFilled).toFixed(18) : '0';

  return {
    orderId: incoming.orderId,
    status: incoming.status,
    filledAmount: incoming.filledAmount,
    avgPrice,
    trades,
  };
}
