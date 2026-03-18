import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { Pool } from 'pg';

dotenv.config();

const BASE_RPC_URL     = process.env.BASE_RPC_URL     || 'https://mainnet.base.org';
const EXCHANGE_ADDRESS = process.env.AGENT_EXCHANGE_CORE_ADDRESS || '';
const WALLET_ADDRESS   = process.env.AGENT_WALLET_ADDRESS        || '';
const DB_URL           = process.env.DB_URL || 'postgresql://agent:agentpass@localhost:5432/agent_exchange';
const POLL_BLOCKS      = parseInt(process.env.INDEXER_POLL_BLOCKS || '100');

const pool = new Pool({ connectionString: DB_URL });

// ── ABIs (minimal) ────────────────────────────────────────────────────────────

const EXCHANGE_ABI = [
  'event TradeExecuted(uint256 indexed tradeId, address indexed agent, bytes32 indexed pairId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
  'event LiquidityAdded(bytes32 indexed pairId, address indexed provider, uint256 amount0, uint256 amount1)',
  'event PairCreated(bytes32 indexed pairId, address indexed token0, address indexed token1)',
];

const WALLET_ABI = [
  'event AgentRegistered(address indexed agent, uint256 stake)',
  'event AgentBlacklisted(address indexed agent, uint256 slashedStake)',
  'event AgentDeactivated(address indexed agent)',
  'event ScoreUpdated(address indexed agent, uint256 oldScore, uint256 newScore)',
];

// ── State ─────────────────────────────────────────────────────────────────────

let lastProcessedBlock = 0;

async function getStartBlock(provider: ethers.JsonRpcProvider): Promise<number> {
  // Persist last processed block in DB to survive restarts
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM activity_log WHERE action_type = 'indexer_checkpoint' ORDER BY created_at DESC LIMIT 1`
  );
  if (result.rows.length > 0) {
    return parseInt(result.rows[0].value || '0');
  }
  // Start from current block on first run
  return await provider.getBlockNumber();
}

async function saveCheckpoint(block: number): Promise<void> {
  await pool.query(
    `INSERT INTO activity_log (action_type, details) VALUES ('indexer_checkpoint', $1)`,
    [JSON.stringify({ block, value: String(block) })]
  );
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleTradeExecuted(
  tradeId: bigint, agent: string, pairId: string,
  tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint,
  txHash: string
): Promise<void> {
  const tradeIdStr = `onchain-${tradeId.toString()}`;
  try {
    // Ensure agent exists
    await pool.query(
      `INSERT INTO agents (wallet_address) VALUES ($1) ON CONFLICT DO NOTHING`,
      [agent.toLowerCase()]
    );
    const agentRow = await pool.query<{ id: number }>(
      'SELECT id FROM agents WHERE wallet_address = $1',
      [agent.toLowerCase()]
    );
    const agentId = agentRow.rows[0]?.id;
    if (!agentId) return;

    // Insert a synthetic order if not present
    const orderId = `onchain-order-${tradeId}`;
    await pool.query(
      `INSERT INTO orders (order_id, agent_id, pair, side, order_type, amount, price, filled_amount, status)
       VALUES ($1, $2, $3, 'buy', 'market', $4, 0, $4, 'filled')
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, agentId, pairId, ethers.formatUnits(amountIn, 18)]
    );

    await pool.query(
      `INSERT INTO trades (trade_id, agent_id, order_id, pair, side, amount, price, fee_usdc, gas_used, tx_hash)
       VALUES ($1, $2, $3, $4, 'buy', $5, $6, 0, 0, $7)
       ON CONFLICT (trade_id) DO NOTHING`,
      [
        tradeIdStr, agentId, orderId, pairId,
        ethers.formatUnits(amountIn, 18),
        ethers.formatUnits(amountOut, 18),
        txHash,
      ]
    );

    console.log(`[indexer] Trade ${tradeId} indexed: agent=${agent} txHash=${txHash}`);
  } catch (err) {
    console.error('[indexer] handleTradeExecuted error:', err);
  }
}

async function handleAgentRegistered(agent: string, stake: bigint): Promise<void> {
  await pool.query(
    `INSERT INTO agents (wallet_address, stake_usdc, is_active)
     VALUES ($1, $2, true)
     ON CONFLICT (wallet_address) DO UPDATE
       SET stake_usdc = $2, is_active = true, updated_at = NOW()`,
    [agent.toLowerCase(), ethers.formatUnits(stake, 6)]
  );
  console.log(`[indexer] Agent registered: ${agent} stake=${ethers.formatUnits(stake, 6)} USDC`);
}

async function handleAgentBlacklisted(agent: string): Promise<void> {
  await pool.query(
    `UPDATE agents SET is_blacklisted = true, is_active = false, updated_at = NOW()
     WHERE wallet_address = $1`,
    [agent.toLowerCase()]
  );
  console.log(`[indexer] Agent blacklisted: ${agent}`);
}

// ── Main polling loop ─────────────────────────────────────────────────────────

async function poll(
  provider: ethers.JsonRpcProvider,
  exchangeContract: ethers.Contract | null,
  walletContract: ethers.Contract | null
): Promise<void> {
  const currentBlock = await provider.getBlockNumber();
  if (currentBlock <= lastProcessedBlock) return;

  const fromBlock = lastProcessedBlock + 1;
  const toBlock   = Math.min(fromBlock + POLL_BLOCKS - 1, currentBlock);

  console.log(`[indexer] Processing blocks ${fromBlock}–${toBlock}`);

  if (exchangeContract) {
    const tradeFilter = exchangeContract.filters.TradeExecuted();
    const tradeEvents = await exchangeContract.queryFilter(tradeFilter, fromBlock, toBlock);
    for (const e of tradeEvents) {
      if (!('args' in e)) continue;
      const { tradeId, agent, pairId, tokenIn, tokenOut, amountIn, amountOut } = e.args as unknown as {
        tradeId: bigint; agent: string; pairId: string;
        tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint;
      };
      await handleTradeExecuted(tradeId, agent, pairId, tokenIn, tokenOut, amountIn, amountOut, e.transactionHash);
    }
  }

  if (walletContract) {
    const regFilter  = walletContract.filters.AgentRegistered();
    const blkFilter  = walletContract.filters.AgentBlacklisted();

    const [regEvents, blkEvents] = await Promise.all([
      walletContract.queryFilter(regFilter, fromBlock, toBlock),
      walletContract.queryFilter(blkFilter, fromBlock, toBlock),
    ]);

    for (const e of regEvents) {
      if (!('args' in e)) continue;
      const { agent, stake } = e.args as unknown as { agent: string; stake: bigint };
      await handleAgentRegistered(agent, stake);
    }
    for (const e of blkEvents) {
      if (!('args' in e)) continue;
      const { agent } = e.args as unknown as { agent: string };
      await handleAgentBlacklisted(agent);
    }
  }

  lastProcessedBlock = toBlock;
  if (toBlock % 500 === 0) await saveCheckpoint(toBlock);
}

async function main(): Promise<void> {
  if (!EXCHANGE_ADDRESS && !WALLET_ADDRESS) {
    console.log('[indexer] No contract addresses configured — running in standby mode.');
    console.log('[indexer] Set AGENT_EXCHANGE_CORE_ADDRESS and AGENT_WALLET_ADDRESS to enable indexing.');

    // Keep process alive, retry every 60s
    setInterval(() => {
      console.log('[indexer] Waiting for contract addresses...');
    }, 60_000);
    return;
  }

  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
  lastProcessedBlock = await getStartBlock(provider);
  console.log(`[indexer] Starting from block ${lastProcessedBlock}`);

  const exchangeContract = EXCHANGE_ADDRESS
    ? new ethers.Contract(EXCHANGE_ADDRESS, EXCHANGE_ABI, provider)
    : null;

  const walletContract = WALLET_ADDRESS
    ? new ethers.Contract(WALLET_ADDRESS, WALLET_ABI, provider)
    : null;

  // Poll every 15 seconds (Base produces ~2s blocks)
  const INTERVAL = parseInt(process.env.INDEXER_INTERVAL_MS || '15000');
  setInterval(() => poll(provider, exchangeContract, walletContract).catch(console.error), INTERVAL);

  console.log(`[indexer] Polling every ${INTERVAL / 1000}s`);
}

main().catch((err) => {
  console.error('[indexer] Fatal:', err);
  process.exit(1);
});
