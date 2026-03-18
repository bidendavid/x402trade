import axios from 'axios';
import { getRedis } from './lib/redis';

// Map trading pair base token → CoinGecko ID
const COINGECKO_IDS: Record<string, string> = {
  WETH: 'ethereum',
  WBTC: 'wrapped-bitcoin',
  USDT: 'tether',
  LINK: 'chainlink',
  OP:   'optimism',
};

// Pairs we track (quote is always USDC)
const PAIRS = ['USDC/WETH', 'USDC/WBTC', 'USDC/USDT', 'USDC/LINK', 'USDC/OP'];

// Simple ring buffer per pair to track price history for manipulation detection
const priceHistory: Record<string, number[]> = {};
const HISTORY_SIZE = 20;

export interface PriceData {
  pair: string;
  price: string;
  change24h: string;
  volume24h: string;
  high24h: string;
  low24h: string;
  updatedAt: number;
}

export async function fetchAndStorePrices(): Promise<void> {
  const ids = Object.values(COINGECKO_IDS).join(',');

  const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
    params: {
      vs_currency: 'usd',
      ids,
      price_change_percentage: '24h',
      per_page: 20,
      page: 1,
    },
    timeout: 10_000,
  });

  const coins: Array<{
    id: string;
    current_price: number;
    price_change_percentage_24h: number;
    total_volume: number;
    high_24h: number;
    low_24h: number;
  }> = response.data;

  const redis = getRedis();
  const pipeline = redis.pipeline();

  // Build reverse map: coingecko_id → token symbol
  const idToToken: Record<string, string> = {};
  for (const [token, id] of Object.entries(COINGECKO_IDS)) {
    idToToken[id] = token;
  }

  for (const coin of coins) {
    const token = idToToken[coin.id];
    if (!token) continue;

    const pair = `USDC/${token}`;
    const pk = pair.replace('/', '-');
    const price = coin.current_price;

    // Manipulation check: flag if price moves > 20% from recent average
    if (!priceHistory[pk]) priceHistory[pk] = [];
    const hist = priceHistory[pk];
    if (hist.length >= 2) {
      const avg = hist.slice(-5).reduce((a, b) => a + b, 0) / Math.min(hist.length, 5);
      const deviation = Math.abs(price - avg) / avg;
      if (deviation > 0.20) {
        console.warn(`[oracle] Price manipulation detected for ${pair}: ${avg.toFixed(2)} → ${price} (${(deviation * 100).toFixed(1)}%)`);
        pipeline.set(`price_alert:${pk}`, JSON.stringify({ avg, price, deviation, timestamp: Date.now() }), 'EX', 300);
        // Use previous price instead of suspicious new price
        continue;
      }
    }
    hist.push(price);
    if (hist.length > HISTORY_SIZE) hist.shift();

    const priceStr = price.toFixed(18);
    pipeline.set(`price:${pk}`, priceStr);
    pipeline.set(`change24h:${pk}`, (coin.price_change_percentage_24h ?? 0).toFixed(4));
    pipeline.set(`volume24h:${pk}`, (coin.total_volume ?? 0).toFixed(2));
    pipeline.set(`high24h:${pk}`, (coin.high_24h ?? price).toFixed(18));
    pipeline.set(`low24h:${pk}`, (coin.low_24h ?? price).toFixed(18));

    // Publish price update to Redis pub/sub for WebSocket subscribers
    pipeline.publish(`price_update:${pk}`, priceStr);
  }

  await pipeline.exec();
  console.log(`[oracle] Prices updated at ${new Date().toISOString()}`);
}

export async function getPrices(): Promise<PriceData[]> {
  const redis = getRedis();
  const result: PriceData[] = [];

  for (const pair of PAIRS) {
    const pk = pair.replace('/', '-');
    const [price, change24h, volume24h, high24h, low24h] = await Promise.all([
      redis.get(`price:${pk}`),
      redis.get(`change24h:${pk}`),
      redis.get(`volume24h:${pk}`),
      redis.get(`high24h:${pk}`),
      redis.get(`low24h:${pk}`),
    ]);

    result.push({
      pair,
      price: price || '0',
      change24h: change24h || '0',
      volume24h: volume24h || '0',
      high24h: high24h || '0',
      low24h: low24h || '0',
      updatedAt: Date.now(),
    });
  }
  return result;
}
