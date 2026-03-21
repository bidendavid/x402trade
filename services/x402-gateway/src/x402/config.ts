export interface EndpointConfig {
  price: string;
  accepts: string[];
  description: string;
}

// Pricing model: all API calls are free.
// Platform earns 0.1% on filled trades only (via TradingVault.settle feeBps=10).
// This aligns platform incentives with market makers — we only earn when trades happen.
export const x402Config: Record<string, EndpointConfig> = {
  'POST /trade': {
    price: '0',
    accepts: ['base:usdc'],
    description: 'Place order (free)',
  },
  'GET /orderbook': {
    price: '0',
    accepts: ['base:usdc'],
    description: 'Get current order book (free)',
  },
  'GET /orders': {
    price: '0',
    accepts: ['base:usdc'],
    description: 'Get agent order history (free)',
  },
  'GET /ticker': {
    price: '0',
    accepts: ['base:usdc'],
    description: 'Get market ticker (free)',
  },
  'GET /trades': {
    price: '0',
    accepts: ['base:usdc'],
    description: 'Get recent trades (free)',
  },
  'DELETE /orders': {
    price: '0',
    accepts: ['base:usdc'],
    description: 'Cancel open order (free)',
  },
  'GET /balance': {
    price: '0',
    accepts: ['base:usdc'],
    description: 'Get agent balance (free)',
  },
};

export const USDC_CONTRACT = process.env.USDC_CONTRACT || '0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C';
