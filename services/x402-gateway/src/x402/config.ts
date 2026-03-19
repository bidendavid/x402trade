export interface EndpointConfig {
  price: string;
  accepts: string[];
  description: string;
}

export const x402Config: Record<string, EndpointConfig> = {
  'POST /trade': {
    price: '0.01',
    accepts: ['base:usdc'],
    description: 'Execute trade for AI agent',
  },
  'GET /orderbook': {
    price: '0.001',
    accepts: ['base:usdc'],
    description: 'Get current order book',
  },
  'GET /orders': {
    price: '0.001',
    accepts: ['base:usdc'],
    description: 'Get agent order history',
  },
  'GET /ticker': {
    price: '0.001',
    accepts: ['base:usdc'],
    description: 'Get market ticker',
  },
  'GET /trades': {
    price: '0.001',
    accepts: ['base:usdc'],
    description: 'Get recent trades',
  },
  'DELETE /orders': {
    price: '0',
    accepts: ['base:usdc'],
    description: 'Cancel open order (free, requires wallet auth)',
  },
  'GET /balance': {
    price: '0',
    accepts: ['base:usdc'],
    description: 'Get agent balance (free, requires wallet auth)',
  },
};

export const USDC_CONTRACT = process.env.USDC_CONTRACT || '0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C';
