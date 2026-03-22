/**
 * Order matching engine unit tests.
 * All Redis and DB calls are mocked — no infrastructure required.
 */
import { randomUUID } from 'crypto';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock NATS before importing matcher
jest.mock('nats', () => ({
  connect: jest.fn(async () => ({
    isClosed: () => false,
    publish: jest.fn(),
  })),
  StringCodec: jest.fn(() => ({ encode: (s: string) => s, decode: (s: string) => s })),
}));

// Mock balance locking
jest.mock('../lib/balance', () => ({
  lockForBuy:  jest.fn(async () => {}),
  lockForSell: jest.fn(async () => {}),
  unlockForCancel: jest.fn(async () => {}),
}));

// Provide real in-memory redis for book operations
jest.mock('../lib/redis', () => jest.requireActual('./__mocks__/redis'));
jest.mock('../lib/db',    () => jest.requireActual('./__mocks__/db'));

import { matchOrder } from '../orderbook/matcher';
import { getRedis }   from '../lib/redis';
import { getPool }    from '../lib/db';
import { Order }      from '../types';
import { lockForBuy, lockForSell } from '../lib/balance';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId:     randomUUID(),
    agentWallet: '0xaaaa',
    pair:        'ETH/USDC',
    side:        'buy',
    type:        'limit',
    amount:      '1.000000',
    price:       '3000.000000000000000000',
    filledAmount: '0.000000',
    status:      'pending',
    timestamp:   Date.now(),
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  (getRedis() as any)._reset();

  // DB: upsertAgent returns id=1, persistOrder/persistTrade are no-ops
  const pool = getPool() as any;
  pool._queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('INSERT INTO agents')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (sql.includes('INSERT INTO orders')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO trades')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE orders'))      return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('matchOrder — no resting orders', () => {
  it('limit buy: goes to book as pending', async () => {
    const order = makeOrder({ side: 'buy', type: 'limit', amount: '1.0', price: '3000.0' });
    const result = await matchOrder(order);

    expect(result.status).toBe('pending');
    expect(result.filledAmount).toBe('0.000000');
    expect(result.trades).toHaveLength(0);
    expect(lockForBuy).toHaveBeenCalledWith(order.agentWallet, '3000.000000');
  });

  it('limit sell: goes to book as pending', async () => {
    const order = makeOrder({ side: 'sell', type: 'limit', amount: '2.0', price: '3100.0' });
    const result = await matchOrder(order);

    expect(result.status).toBe('pending');
    expect(lockForSell).toHaveBeenCalledWith(order.agentWallet, '2.0');
  });

  it('market buy: cancelled with no asks (IOC behaviour)', async () => {
    const order = makeOrder({ side: 'buy', type: 'market', price: '0' });
    const result = await matchOrder(order);
    expect(result.status).toBe('cancelled');
    expect(result.trades).toHaveLength(0);
  });
});

describe('matchOrder — full fill', () => {
  it('buy order fully fills against a resting ask at same price', async () => {
    const redis = getRedis() as any;

    // Place a resting sell order in the book
    const restingOrderId = randomUUID();
    const restingMember = `3000.0:1.000000:${restingOrderId}`;
    await redis.zadd('asks:ETH-USDC', 3000.0, restingMember);
    await redis.hset(`order:${restingOrderId}`, {
      orderId: restingOrderId,
      agentWallet: '0xbbbb',
      pair: 'ETH/USDC',
      side: 'sell',
      type: 'limit',
      amount: '1.000000',
      price: '3000.0',
      filledAmount: '0.000000',
      status: 'pending',
      timestamp: String(Date.now()),
    });

    const incoming = makeOrder({ side: 'buy', type: 'limit', amount: '1.000000', price: '3000.0' });
    const result = await matchOrder(incoming);

    expect(result.status).toBe('filled');
    expect(result.filledAmount).toBe('1.000000');
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].amount).toBe('1.000000');
    // price stored at 18-decimal precision
    expect(parseFloat(result.trades[0].price)).toBeCloseTo(3000, 5);
  });
});

describe('matchOrder — partial fill', () => {
  it('buy 2 ETH fills against 1 ETH resting ask, remainder goes to book', async () => {
    const redis = getRedis() as any;

    const restingOrderId = randomUUID();
    await redis.zadd('asks:ETH-USDC', 3000.0, `3000.0:1.000000:${restingOrderId}`);
    await redis.hset(`order:${restingOrderId}`, {
      orderId: restingOrderId, agentWallet: '0xbbbb', pair: 'ETH/USDC',
      side: 'sell', type: 'limit', amount: '1.000000', price: '3000.0',
      filledAmount: '0.000000', status: 'pending', timestamp: String(Date.now()),
    });

    const incoming = makeOrder({ side: 'buy', type: 'limit', amount: '2.000000', price: '3000.0' });
    const result = await matchOrder(incoming);

    expect(result.status).toBe('partial');
    expect(result.filledAmount).toBe('1.000000');
    expect(result.trades).toHaveLength(1);

    // Remaining 1 ETH should be in the bids book
    const bids = await redis.zrevrange('bids:ETH-USDC', 0, 10);
    expect(bids.length).toBeGreaterThan(0);
  });
});

describe('matchOrder — price crossing', () => {
  it('limit buy does not fill if ask price > bid price', async () => {
    const redis = getRedis() as any;

    await redis.zadd('asks:ETH-USDC', 3100.0, `3100.0:1.0:${randomUUID()}`);
    await redis.hset(`order:${randomUUID()}`, {
      orderId: randomUUID(), agentWallet: '0xbbbb', pair: 'ETH/USDC',
      side: 'sell', type: 'limit', amount: '1.0', price: '3100.0',
      filledAmount: '0.0', status: 'pending', timestamp: String(Date.now()),
    });

    const incoming = makeOrder({ side: 'buy', type: 'limit', amount: '1.0', price: '3000.0' });
    const result = await matchOrder(incoming);

    expect(result.status).toBe('pending');
    expect(result.trades).toHaveLength(0);
  });
});

describe('matchOrder — fee calculation', () => {
  it('applies 0.3% fee correctly', async () => {
    const redis = getRedis() as any;
    const restingId = randomUUID();

    await redis.zadd('asks:ETH-USDC', 3000.0, `3000.0:1.0:${restingId}`);
    await redis.hset(`order:${restingId}`, {
      orderId: restingId, agentWallet: '0xbbbb', pair: 'ETH/USDC',
      side: 'sell', type: 'limit', amount: '1.0', price: '3000.0',
      filledAmount: '0.0', status: 'pending', timestamp: String(Date.now()),
    });

    const incoming = makeOrder({ side: 'buy', type: 'limit', amount: '1.0', price: '3000.0' });
    const result = await matchOrder(incoming);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    // usdcTotal = 1 * 3000 = 3000; fee = 3000 * 0.003 = 9.000000
    expect(trade.usdcTotal).toBe('3000.000000');
    expect(trade.fee).toBe('9.000000');
  });
});
