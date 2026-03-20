/**
 * Market Maker Configuration
 * All settings can be overridden via environment variables.
 */
export const config = {
  // ── Required ──────────────────────────────────────────────────────────────
  privateKey:  process.env.PRIVATE_KEY  || '',
  gatewayUrl:  process.env.GATEWAY_URL  || 'https://api.getx402.trade',

  // ── Trading ───────────────────────────────────────────────────────────────
  pair:        process.env.PAIR         || 'ETH-USDC',

  // How much to buy/sell per order (in base token: ETH or BTC)
  orderSize:   parseFloat(process.env.ORDER_SIZE   || '0.05'),

  // Number of price levels on each side
  levels:      parseInt(process.env.LEVELS         || '3'),

  // Spread between each level (e.g. 0.002 = 0.2%)
  spread:      parseFloat(process.env.SPREAD       || '0.002'),

  // How often to refresh orders (seconds)
  refreshSecs: parseInt(process.env.REFRESH_SECS   || '30'),

  // ── Risk controls ─────────────────────────────────────────────────────────

  // Stop if price moves more than X% from when we started
  maxPriceDriftPct: parseFloat(process.env.MAX_PRICE_DRIFT_PCT || '10'),

  // Stop if USDC balance drops below this amount
  minUsdcBalance:   parseFloat(process.env.MIN_USDC_BALANCE   || '50'),

  // Stop if ETH balance drops below this amount
  minEthBalance:    parseFloat(process.env.MIN_ETH_BALANCE    || '0.05'),
};

export function validate(): void {
  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY is required. Set it in your .env file.');
  }
  if (!config.privateKey.startsWith('0x')) {
    throw new Error('PRIVATE_KEY must start with 0x');
  }
}
