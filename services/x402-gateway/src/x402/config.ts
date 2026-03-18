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
  'GET /balance': {
    price: '0.001',
    accepts: ['base:usdc'],
    description: 'Get agent wallet balance',
  },
  'GET /orders': {
    price: '0.005',
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
};

export const USDC_CONTRACT = process.env.USDC_CONTRACT || '0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C';
export const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
export const X402_PAYMENT_ADDRESS = process.env.X402_PAYMENT_ADDRESS || '';
