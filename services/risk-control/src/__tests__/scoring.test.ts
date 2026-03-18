/**
 * Risk control scoring unit tests.
 * Mocks Redis and DB — no infrastructure required.
 */

jest.mock('../lib/redis', () => jest.requireActual('./__mocks__/redis'));
jest.mock('../lib/db',    () => jest.requireActual('./__mocks__/db'));

import {
  getScore,
  updateScore,
  isBlacklisted,
  addToBlacklist,
  removeFromBlacklist,
  checkRateLimit,
  SCORE_RULES,
} from '../scoring';
import { getRedis } from '../lib/redis';
import { getPool }  from '../lib/db';

const WALLET = '0xtest0000000000000000000000000000000000001';

beforeEach(() => {
  (getRedis() as any)._reset();
  (getPool() as any)._queryMock.mockReset();
  (getPool() as any)._queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT score')) return { rows: [{ score: 80 }], rowCount: 1 };
    if (sql.includes('INSERT INTO agents')) return { rows: [{ score: 81 }], rowCount: 1 };
    if (sql.includes('UPDATE agents')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

// ── getScore ──────────────────────────────────────────────────────────────────

describe('getScore', () => {
  it('returns score from DB when cache is cold', async () => {
    const score = await getScore(WALLET);
    expect(score).toBe(80);
  });

  it('returns score from Redis cache when warm', async () => {
    (getRedis() as any)._set(`score:${WALLET.toLowerCase()}`, '75');
    const score = await getScore(WALLET);
    expect(score).toBe(75);
    // DB should not be queried when cache hits
    expect((getPool() as any)._queryMock).not.toHaveBeenCalled();
  });

  it('defaults to 100 for unknown agents', async () => {
    (getPool() as any)._queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const score = await getScore(WALLET);
    expect(score).toBe(100);
  });
});

// ── updateScore ───────────────────────────────────────────────────────────────

describe('updateScore', () => {
  it('applies successfulTrade delta (+1)', async () => {
    (getPool() as any)._queryMock.mockResolvedValueOnce({ rows: [{ score: 81 }], rowCount: 1 });
    const newScore = await updateScore(WALLET, SCORE_RULES.successfulTrade);
    expect(newScore).toBe(81);
  });

  it('applies cancelledOrder delta (-2)', async () => {
    (getPool() as any)._queryMock.mockResolvedValueOnce({ rows: [{ score: 78 }], rowCount: 1 });
    const newScore = await updateScore(WALLET, SCORE_RULES.cancelledOrder);
    expect(newScore).toBe(78);
  });

  it('updates Redis cache with new score', async () => {
    (getPool() as any)._queryMock.mockResolvedValueOnce({ rows: [{ score: 60 }], rowCount: 1 });
    await updateScore(WALLET, -20);
    const cached = (getRedis() as any)._store[`score:${WALLET.toLowerCase()}`];
    expect(cached).toBe('60');
  });
});

// ── isBlacklisted / addToBlacklist / removeFromBlacklist ──────────────────────

describe('blacklist operations', () => {
  it('isBlacklisted returns false for clean wallet', async () => {
    expect(await isBlacklisted(WALLET)).toBe(false);
  });

  it('isBlacklisted returns true after addToBlacklist', async () => {
    await addToBlacklist(WALLET, 'wash trading');
    expect(await isBlacklisted(WALLET)).toBe(true);
  });

  it('removeFromBlacklist clears the flag', async () => {
    await addToBlacklist(WALLET, 'wash trading');
    await removeFromBlacklist(WALLET);
    expect(await isBlacklisted(WALLET)).toBe(false);
  });
});

// ── checkRateLimit ─────────────────────────────────────────────────────────────

describe('checkRateLimit', () => {
  it('allows requests within tier limit (score ≥ 80 → 120/min)', async () => {
    const allowed = await checkRateLimit(WALLET, 90);
    expect(allowed).toBe(true);
  });

  it('blocks after exceeding limit for low-score agents (score < 30 → 5/min)', async () => {
    // Simulate 5 prior calls by setting the counter
    const minute = Math.floor(Date.now() / 60_000);
    (getRedis() as any)._set(`rate:${WALLET.toLowerCase()}:${minute}`, '5');
    const allowed = await checkRateLimit(WALLET, 10);
    expect(allowed).toBe(false);
  });

  it('allows first call for any score tier', async () => {
    const allowed = await checkRateLimit(WALLET, 20);
    expect(allowed).toBe(true);
  });
});

// ── SCORE_RULES constants ──────────────────────────────────────────────────────

describe('SCORE_RULES', () => {
  it('has correct delta values', () => {
    expect(SCORE_RULES.successfulTrade).toBe(1);
    expect(SCORE_RULES.cancelledOrder).toBe(-2);
    expect(SCORE_RULES.priceDeviation).toBe(-5);
    expect(SCORE_RULES.abnormalFrequency).toBe(-10);
    expect(SCORE_RULES.manualPenalty).toBe(-20);
  });
});
