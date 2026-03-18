import { getPool } from './lib/db';
import { getRedis } from './lib/redis';

// Score deltas per action (from tech spec)
export const SCORE_RULES = {
  successfulTrade:   +1,
  cancelledOrder:    -2,
  priceDeviation:    -5,
  abnormalFrequency: -10,
  manualPenalty:     -20,
} as const;

const SCORE_MIN = 0;
const SCORE_MAX = 100;
const CACHE_TTL = 60; // seconds

export async function getScore(walletAddress: string): Promise<number> {
  const redis = getRedis();
  const key = `score:${walletAddress.toLowerCase()}`;

  const cached = await redis.get(key);
  if (cached !== null) return parseInt(cached);

  const pool = getPool();
  const result = await pool.query<{ score: number }>(
    'SELECT score FROM agents WHERE wallet_address = $1',
    [walletAddress.toLowerCase()]
  );

  const score = result.rows[0]?.score ?? 100;
  await redis.set(key, String(score), 'EX', CACHE_TTL);
  return score;
}

export async function updateScore(walletAddress: string, delta: number): Promise<number> {
  const pool = getPool();
  const redis = getRedis();
  const addr = walletAddress.toLowerCase();

  // Upsert agent with clamped new score
  const result = await pool.query<{ score: number }>(
    `INSERT INTO agents (wallet_address, score, is_active, is_blacklisted)
     VALUES ($1, GREATEST($2, $3), true, false)
     ON CONFLICT (wallet_address) DO UPDATE
       SET score      = GREATEST($3, LEAST($4, agents.score + $2)),
           updated_at = NOW()
     RETURNING score`,
    [addr, delta, SCORE_MIN, SCORE_MAX]
  );

  const newScore = result.rows[0].score;
  await redis.set(`score:${addr}`, String(newScore), 'EX', CACHE_TTL);
  return newScore;
}

export async function isBlacklisted(walletAddress: string): Promise<boolean> {
  const redis = getRedis();
  const key = `blacklist:${walletAddress.toLowerCase()}`;
  return (await redis.exists(key)) === 1;
}

export async function addToBlacklist(walletAddress: string, reason: string): Promise<void> {
  const pool = getPool();
  const redis = getRedis();
  const addr = walletAddress.toLowerCase();

  await pool.query(
    `UPDATE agents SET is_blacklisted = true, is_active = false, updated_at = NOW()
     WHERE wallet_address = $1`,
    [addr]
  );

  await redis.set(`blacklist:${addr}`, reason, 'EX', 30 * 24 * 3600); // 30 days
  await redis.del(`score:${addr}`);
}

export async function removeFromBlacklist(walletAddress: string): Promise<void> {
  const pool = getPool();
  const redis = getRedis();
  const addr = walletAddress.toLowerCase();

  await pool.query(
    `UPDATE agents SET is_blacklisted = false, is_active = true, score = 50, updated_at = NOW()
     WHERE wallet_address = $1`,
    [addr]
  );

  await redis.del(`blacklist:${addr}`);
  await redis.set(`score:${addr}`, '50', 'EX', CACHE_TTL);
}

// Rate limiting: returns false if agent exceeded call quota
export async function checkRateLimit(walletAddress: string, score: number): Promise<boolean> {
  const redis = getRedis();
  const addr = walletAddress.toLowerCase();
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rate:${addr}:${minute}`;

  // Rate limit varies by score tier
  const maxCalls = score >= 80 ? 120 : score >= 50 ? 60 : score >= 30 ? 20 : 5;

  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 90); // expire after 1.5 min

  return count <= maxCalls;
}
