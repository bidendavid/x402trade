import { getRedis } from '../lib/redis';
import { Order } from '../types';

// Pair key: "USDC/WETH" → "USDC-WETH"
function pk(pair: string): string {
  return pair.replace('/', '-');
}

// Member format: "{price}:{amount}:{orderId}"
// Price stored as-is; bids sorted by score desc (ZREVRANGE), asks asc (ZRANGE)
function toMember(order: Order): string {
  return `${order.price}:${order.amount}:${order.orderId}`;
}

export async function addToBook(order: Order): Promise<void> {
  const redis = getRedis();
  const score = parseFloat(order.price);
  const key = order.side === 'buy' ? `bids:${pk(order.pair)}` : `asks:${pk(order.pair)}`;

  await redis.pipeline()
    .zadd(key, score, toMember(order))
    .hset(`order:${order.orderId}`, {
      orderId: order.orderId,
      agentWallet: order.agentWallet,
      pair: order.pair,
      side: order.side,
      type: order.type,
      amount: order.amount,
      price: order.price,
      filledAmount: order.filledAmount,
      status: order.status,
      timestamp: String(order.timestamp),
    })
    .sadd(`agent:pending:${order.agentWallet}`, order.orderId)
    .exec();
}

export async function removeFromBook(order: Order): Promise<void> {
  const redis = getRedis();
  const key = order.side === 'buy' ? `bids:${pk(order.pair)}` : `asks:${pk(order.pair)}`;

  await redis.pipeline()
    .zrem(key, toMember(order))
    .srem(`agent:pending:${order.agentWallet}`, order.orderId)
    .del(`order:${order.orderId}`)
    .exec();
}

export async function updateOrderStatus(order: Order): Promise<void> {
  const redis = getRedis();
  await redis.hset(`order:${order.orderId}`, {
    filledAmount: order.filledAmount,
    status: order.status,
  });
}

// Fetch best asks (lowest price first) for matching against buy orders
export async function getBestAsks(pair: string, count: number): Promise<Order[]> {
  const redis = getRedis();
  const members = await redis.zrange(`asks:${pk(pair)}`, 0, count - 1);
  return fetchOrders(members);
}

// Fetch best bids (highest price first) for matching against sell orders
export async function getBestBids(pair: string, count: number): Promise<Order[]> {
  const redis = getRedis();
  const members = await redis.zrevrange(`bids:${pk(pair)}`, 0, count - 1);
  return fetchOrders(members);
}

async function fetchOrders(members: string[]): Promise<Order[]> {
  if (members.length === 0) return [];
  const redis = getRedis();
  const orders: Order[] = [];
  for (const m of members) {
    const parts = m.split(':');
    const orderId = parts.slice(2).join(':');
    const raw = await redis.hgetall(`order:${orderId}`);
    if (raw && raw.orderId) orders.push(raw as unknown as Order);
  }
  return orders;
}

export async function updatePriceCache(pair: string, price: string, amount: string): Promise<void> {
  const redis = getRedis();
  const key = pk(pair);
  const pipeline = redis.pipeline();

  pipeline.set(`price:${key}`, price);

  const [high, low] = await Promise.all([
    redis.get(`high24h:${key}`),
    redis.get(`low24h:${key}`),
  ]);
  const p = parseFloat(price);
  if (!high || p > parseFloat(high)) pipeline.set(`high24h:${key}`, price);
  if (!low || p < parseFloat(low))   pipeline.set(`low24h:${key}`, price);

  const vol = await redis.get(`volume24h:${key}`);
  pipeline.set(`volume24h:${key}`, (parseFloat(vol || '0') + parseFloat(amount)).toFixed(6));

  const entry = JSON.stringify({ price, amount, timestamp: Date.now() });
  pipeline.lpush(`trades:${key}`, entry).ltrim(`trades:${key}`, 0, 999);
  pipeline.lpush('trades:all', entry).ltrim('trades:all', 0, 999);

  await pipeline.exec();

  // Publish orderbook snapshot for WebSocket consumers
  const [bids, asks] = await Promise.all([
    redis.zrevrange(`bids:${key}`, 0, 19, 'WITHSCORES'),
    redis.zrange(`asks:${key}`, 0, 19, 'WITHSCORES'),
  ]);
  const snapshot = { bids, asks, timestamp: Date.now() };
  await redis.publish(`orderbook:${key}`, JSON.stringify(snapshot));
}
