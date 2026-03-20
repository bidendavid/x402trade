#!/usr/bin/env node
/**
 * x402Trade Market Maker Agent
 *
 * Provides liquidity on x402Trade by continuously placing buy and sell
 * limit orders around the current market price.
 *
 * Setup:
 *   cp .env.example .env
 *   # Fill in PRIVATE_KEY and optionally adjust other settings
 *   npm start
 */

import { validate, config } from './config.js';
import { runCycle, shutdown, wallet } from './strategy.js';

// ── Startup ───────────────────────────────────────────────────────────────────

validate();

console.log('╔════════════════════════════════════════╗');
console.log('║   x402Trade Market Maker Agent         ║');
console.log('╚════════════════════════════════════════╝');
console.log(`Wallet  : ${wallet.address}`);
console.log(`Pair    : ${config.pair}`);
console.log(`Levels  : ${config.levels} per side`);
console.log(`Size    : ${config.orderSize} per order`);
console.log(`Spread  : ${(config.spread * 100).toFixed(2)}% per level`);
console.log(`Refresh : every ${config.refreshSecs}s`);
console.log(`Gateway : ${config.gatewayUrl}`);
console.log('');
console.log('Risk limits:');
console.log(`  Max price drift : ${config.maxPriceDriftPct}%`);
console.log(`  Min USDC balance: $${config.minUsdcBalance}`);
console.log(`  Min ETH balance : ${config.minEthBalance} ETH`);
console.log('');
console.log('Press Ctrl+C to stop gracefully.\n');

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let stopping = false;

process.on('SIGINT',  () => { if (!stopping) { stopping = true; shutdown().then(() => process.exit(0)); } });
process.on('SIGTERM', () => { if (!stopping) { stopping = true; shutdown().then(() => process.exit(0)); } });

// ── Main loop ─────────────────────────────────────────────────────────────────

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      await runCycle();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('STOP:')) {
        // Risk limit hit — cancel orders and exit
        console.error(`\n🛑 ${msg}`);
        await shutdown();
        process.exit(1);
      }
      console.error(`Cycle error (will retry): ${msg}`);
    }

    // Wait for next cycle
    if (!stopping) {
      await new Promise(r => setTimeout(r, config.refreshSecs * 1000));
    }
  }
}

loop();
