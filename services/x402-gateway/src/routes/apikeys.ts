/**
 * API Key management
 *
 * POST /api-key/create  — wallet signs once, server issues an API key
 * GET  /api-key/list    — list all keys for this wallet
 * POST /api-key/revoke  — revoke a key by id
 *
 * The raw API key is shown ONCE at creation and never stored — only its SHA-256 hash.
 * The agent stores the raw key and sends it as:  X-API-Key: xk_<hex>
 */
import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { createHash, randomBytes } from 'crypto';
import { getPool } from '../lib/db';
import { isValidAddress } from '../lib/validate';

const router = Router();

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function generateApiKey(): string {
  return 'xk_' + randomBytes(32).toString('hex');
}

// ── POST /api-key/create ────────────────────────────────────────────────────

router.post('/api-key/create', async (req: Request, res: Response) => {
  const { wallet, signature, label, permissions = 'trade', expiresInDays } = req.body as {
    wallet:        string;
    signature:     string;
    label?:        string;
    permissions?:  string;
    expiresInDays?: number;
  };

  if (!wallet || !signature) {
    res.status(400).json({ error: 'wallet and signature required' });
    return;
  }
  if (!isValidAddress(wallet)) {
    res.status(400).json({ error: 'Invalid wallet address' });
    return;
  }
  if (!['trade', 'readonly'].includes(permissions)) {
    res.status(400).json({ error: 'permissions must be trade or readonly' });
    return;
  }

  // Verify wallet ownership — agent signs a fixed intent message
  const message = `x402Trade: create API key\nwallet: ${wallet.toLowerCase()}\nlabel: ${label || ''}`;
  try {
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== wallet.toLowerCase()) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  } catch {
    res.status(401).json({ error: 'Signature verification failed' });
    return;
  }

  const pool = getPool();
  try {
    // Ensure agent row exists
    await pool.query(
      `INSERT INTO agents (wallet_address, score, is_active, is_blacklisted)
       VALUES ($1, 100, true, false) ON CONFLICT (wallet_address) DO NOTHING`,
      [wallet.toLowerCase()]
    );
    await pool.query(
      `INSERT INTO balances (agent_id, usdc_balance, usdc_locked, eth_balance, eth_locked)
       SELECT id, 0, 0, 0, 0 FROM agents WHERE wallet_address = $1
       ON CONFLICT (agent_id) DO NOTHING`,
      [wallet.toLowerCase()]
    );

    const agentResult = await pool.query(
      'SELECT id FROM agents WHERE wallet_address = $1',
      [wallet.toLowerCase()]
    );
    const agentId = agentResult.rows[0].id as number;

    const rawKey  = generateApiKey();
    const keyHash = sha256(rawKey);

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400_000)
      : null;

    const result = await pool.query(
      `INSERT INTO api_keys (key_hash, agent_id, label, permissions, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [keyHash, agentId, label || null, permissions, expiresAt]
    );

    res.json({
      success:    true,
      keyId:      result.rows[0].id,
      apiKey:     rawKey,          // shown ONCE — store it securely
      label:      label || null,
      permissions,
      expiresAt:  expiresAt?.toISOString() || null,
      createdAt:  result.rows[0].created_at,
      warning:    'Save this key now — it will NOT be shown again.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create API key', message: (err as Error).message });
  }
});

// ── GET /api-key/list ───────────────────────────────────────────────────────

router.get('/api-key/list', async (req: Request, res: Response) => {
  const { wallet, signature } = req.query as { wallet: string; signature: string };

  if (!wallet || !signature) {
    res.status(400).json({ error: 'wallet and signature required' });
    return;
  }

  const message = `x402Trade: list API keys\nwallet: ${wallet.toLowerCase()}`;
  try {
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== wallet.toLowerCase()) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  } catch {
    res.status(401).json({ error: 'Signature verification failed' });
    return;
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT k.id, k.label, k.permissions, k.last_used_at, k.expires_at, k.revoked, k.created_at
       FROM api_keys k
       JOIN agents a ON a.id = k.agent_id
       WHERE a.wallet_address = $1
       ORDER BY k.created_at DESC`,
      [wallet.toLowerCase()]
    );
    res.json({ keys: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list keys', message: (err as Error).message });
  }
});

// ── POST /api-key/revoke ────────────────────────────────────────────────────

router.post('/api-key/revoke', async (req: Request, res: Response) => {
  const { wallet, signature, keyId } = req.body as {
    wallet:    string;
    signature: string;
    keyId:     number;
  };

  if (!wallet || !signature || !keyId) {
    res.status(400).json({ error: 'wallet, signature, keyId required' });
    return;
  }

  const message = `x402Trade: revoke API key ${keyId}\nwallet: ${wallet.toLowerCase()}`;
  try {
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== wallet.toLowerCase()) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  } catch {
    res.status(401).json({ error: 'Signature verification failed' });
    return;
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      `UPDATE api_keys k SET revoked = true
       FROM agents a
       WHERE a.id = k.agent_id
         AND a.wallet_address = $1
         AND k.id = $2
       RETURNING k.id`,
      [wallet.toLowerCase(), keyId]
    );
    if ((result.rowCount ?? 0) === 0) {
      res.status(404).json({ error: 'Key not found or not owned by this wallet' });
      return;
    }
    res.json({ success: true, keyId, revoked: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke key', message: (err as Error).message });
  }
});

export default router;
