#!/usr/bin/env node
/**
 * x402Trade MCP Server
 *
 * Lets AI assistants (Claude, Cursor, etc.) interact with x402Trade directly.
 *
 * Setup:
 *   PRIVATE_KEY=0x...  (your Ethereum wallet private key)
 *   X402_GATEWAY_URL=https://api.getx402.trade  (optional, defaults to production)
 *
 * Tools exposed:
 *   x402_get_price        — Current price, 24h change and volume for a pair
 *   x402_get_orderbook    — Live bids and asks
 *   x402_get_balance      — Your USDC and ETH balance
 *   x402_place_order      — Place a limit or market order
 *   x402_cancel_order     — Cancel an open order
 *   x402_get_orders       — List your open/recent orders
 *   x402_get_recent_trades — Recent fills on a pair
 *   x402_deposit_info     — How to deposit USDC
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ethers } from 'ethers';
import { callApi } from './client.js';

// ── Config ────────────────────────────────────────────────────────────────────

const GATEWAY_URL = (process.env.X402_GATEWAY_URL || 'https://api.getx402.trade').replace(/\/$/, '');
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY) : null;

if (!wallet) {
  process.stderr.write('[x402-mcp] WARNING: PRIVATE_KEY not set. Read-only mode (no trading).\n');
}

function api(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  return callApi(GATEWAY_URL, wallet, method, path, body);
}

// ── Tool Definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'x402_get_price',
    description: 'Get the current price, 24h change, volume, high and low for a trading pair on x402Trade.',
    inputSchema: {
      type: 'object',
      properties: {
        pair: {
          type: 'string',
          description: 'Trading pair. Supported: ETH-USDC, BTC-USDC',
          enum: ['ETH-USDC', 'BTC-USDC'],
        },
      },
      required: ['pair'],
    },
  },
  {
    name: 'x402_get_orderbook',
    description: 'Get the live order book (bids and asks) for a trading pair. Shows current buy and sell orders.',
    inputSchema: {
      type: 'object',
      properties: {
        pair: {
          type: 'string',
          description: 'Trading pair. Supported: ETH-USDC, BTC-USDC',
          enum: ['ETH-USDC', 'BTC-USDC'],
        },
        depth: {
          type: 'number',
          description: 'Number of price levels to return per side. Default 10, max 50.',
          default: 10,
        },
      },
      required: ['pair'],
    },
  },
  {
    name: 'x402_get_balance',
    description: 'Get the USDC and ETH balance for the configured wallet on x402Trade. Requires PRIVATE_KEY to be set.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'x402_place_order',
    description: `Place a buy or sell order on x402Trade.
- Limit order: executes at your specified price or better. Stays in the order book if not immediately matched.
- Market order: executes immediately at the best available price.
Costs $0.01 USDC per call. Requires PRIVATE_KEY and sufficient USDC balance.`,
    inputSchema: {
      type: 'object',
      properties: {
        pair: {
          type: 'string',
          description: 'Trading pair. Supported: ETH-USDC, BTC-USDC',
          enum: ['ETH-USDC', 'BTC-USDC'],
        },
        side: {
          type: 'string',
          description: 'Buy or sell',
          enum: ['buy', 'sell'],
        },
        type: {
          type: 'string',
          description: 'Order type: limit (specify price) or market (best available price)',
          enum: ['limit', 'market'],
        },
        amount: {
          type: 'string',
          description: 'Amount of base token (ETH or BTC) to buy or sell. E.g. "0.1" for 0.1 ETH.',
        },
        price: {
          type: 'string',
          description: 'Price in USDC per base token. Required for limit orders. E.g. "2200" for $2200 per ETH.',
        },
      },
      required: ['pair', 'side', 'type', 'amount'],
    },
  },
  {
    name: 'x402_cancel_order',
    description: 'Cancel an open or partially filled order. Cancellation is free. Locked funds are returned to your balance.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'The order ID to cancel (UUID format, returned when you placed the order)',
        },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'x402_get_orders',
    description: 'List your recent orders — open, filled, cancelled, and partially filled. Costs $0.001 USDC.',
    inputSchema: {
      type: 'object',
      properties: {
        pair: {
          type: 'string',
          description: 'Filter by trading pair. Leave empty to see all pairs.',
          enum: ['ETH-USDC', 'BTC-USDC'],
        },
        limit: {
          type: 'number',
          description: 'Number of orders to return. Default 20, max 50.',
          default: 20,
        },
      },
      required: [],
    },
  },
  {
    name: 'x402_get_recent_trades',
    description: 'Get recent completed trades (fills) on a trading pair. Costs $0.001 USDC.',
    inputSchema: {
      type: 'object',
      properties: {
        pair: {
          type: 'string',
          description: 'Trading pair. Supported: ETH-USDC, BTC-USDC',
          enum: ['ETH-USDC', 'BTC-USDC'],
        },
        limit: {
          type: 'number',
          description: 'Number of recent trades to return. Default 20, max 50.',
          default: 20,
        },
      },
      required: ['pair'],
    },
  },
  {
    name: 'x402_deposit_info',
    description: 'Get instructions and the deposit address for adding USDC to your x402Trade balance.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ── Tool Handlers ─────────────────────────────────────────────────────────────

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {

    case 'x402_get_price': {
      const pair = args.pair as string;
      const data = await api('GET', `/ticker?pair=${pair}`) as Record<string, unknown>;
      return JSON.stringify({
        pair,
        price_usdc: data.price,
        change_24h_pct: data.change24h,
        volume_24h_usdc: data.volume24h,
        high_24h: data.high24h,
        low_24h: data.low24h,
      }, null, 2);
    }

    case 'x402_get_orderbook': {
      const pair = args.pair as string;
      const depth = Math.min((args.depth as number) || 10, 50);
      const data = await api('GET', `/orderbook?pair=${pair}&depth=${depth}`) as Record<string, unknown>;
      return JSON.stringify(data, null, 2);
    }

    case 'x402_get_balance': {
      if (!wallet) return 'Error: PRIVATE_KEY not configured. Set PRIVATE_KEY env var to check balance.';
      const data = await api('GET', '/balance') as Record<string, unknown>;
      return JSON.stringify({
        wallet: wallet.address,
        usdc_balance: data.usdc_balance,
        usdc_locked_in_orders: data.usdc_locked,
        eth_balance: data.eth_balance,
        eth_locked_in_orders: data.eth_locked,
      }, null, 2);
    }

    case 'x402_place_order': {
      if (!wallet) return 'Error: PRIVATE_KEY not configured. Cannot place orders without a wallet.';
      const { pair, side, type, amount, price } = args as {
        pair: string; side: string; type: string; amount: string; price?: string;
      };
      if (type === 'limit' && !price) return 'Error: price is required for limit orders.';

      const data = await api('POST', '/trade', { pair, side, type, amount, price }) as Record<string, unknown>;
      return JSON.stringify({
        order_id: data.orderId,
        status: data.status,
        filled_amount: data.filledAmount,
        avg_fill_price: data.avgPrice,
        trades_count: (data.trades as unknown[])?.length ?? 0,
      }, null, 2);
    }

    case 'x402_cancel_order': {
      if (!wallet) return 'Error: PRIVATE_KEY not configured. Cannot cancel orders without a wallet.';
      const orderId = args.order_id as string;
      const data = await api('DELETE', `/orders/${orderId}`) as Record<string, unknown>;
      return JSON.stringify({
        cancelled: data.success,
        order_id: data.orderId,
        remaining_amount_unlocked: data.remainingAmount,
      }, null, 2);
    }

    case 'x402_get_orders': {
      if (!wallet) return 'Error: PRIVATE_KEY not configured. Cannot list orders without a wallet.';
      const pair = args.pair as string | undefined;
      const limit = Math.min((args.limit as number) || 20, 50);
      const qs = new URLSearchParams({ limit: String(limit) });
      if (pair) qs.set('pair', pair);
      const data = await api('GET', `/orders?${qs}`) as Record<string, unknown>;
      return JSON.stringify(data, null, 2);
    }

    case 'x402_get_recent_trades': {
      const pair = args.pair as string;
      const limit = Math.min((args.limit as number) || 20, 50);
      const data = await api('GET', `/trades?pair=${pair}&limit=${limit}`) as Record<string, unknown>;
      return JSON.stringify(data, null, 2);
    }

    case 'x402_deposit_info': {
      const walletAddr = wallet?.address ?? '(configure PRIVATE_KEY to see your wallet address)';
      return JSON.stringify({
        instructions: [
          '1. Send USDC to the deposit address below on Base L2 (Chain ID: 8453)',
          '2. Wait ~15 seconds for the transaction to confirm',
          '3. Your balance updates automatically — call x402_get_balance to verify',
        ],
        deposit_address: 'See DEPOSIT_ADDRESS in exchange config (ask the exchange operator)',
        network: 'Base L2 (Ethereum Layer 2)',
        token: 'USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C)',
        your_wallet: walletAddr,
        minimum_deposit: 'No minimum',
        note: 'Only send USDC on Base L2. Sending on other networks will result in lost funds.',
      }, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'x402trade', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, (args ?? {}) as Record<string, unknown>);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[x402-mcp] Server started. Wallet: ${wallet?.address ?? 'not configured (read-only)'}\n`);
