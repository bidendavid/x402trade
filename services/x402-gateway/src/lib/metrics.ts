import client from 'prom-client';

// Enable default Node.js metrics (CPU, memory, event loop lag, etc.)
client.collectDefaultMetrics({ prefix: 'x402_' });

// ── HTTP request metrics ───────────────────────────────────────────────────────

export const httpRequestDuration = new client.Histogram({
  name: 'x402_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

export const httpRequestsTotal = new client.Counter({
  name: 'x402_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// ── x402 payment metrics ───────────────────────────────────────────────────────

export const x402PaymentsTotal = new client.Counter({
  name: 'x402_payments_total',
  help: 'Total x402 payment verifications',
  labelNames: ['result'],  // 'valid' | 'invalid' | 'missing'
});

export const x402PaymentDuration = new client.Histogram({
  name: 'x402_payment_verification_duration_seconds',
  help: 'x402 payment verification duration',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

// ── Order metrics ──────────────────────────────────────────────────────────────

export const ordersTotal = new client.Counter({
  name: 'x402_orders_total',
  help: 'Total orders submitted',
  labelNames: ['side', 'type', 'status'],
});

export const orderMatchDuration = new client.Histogram({
  name: 'x402_order_match_duration_seconds',
  help: 'Order match round-trip duration (NATS request to order-engine)',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// ── WebSocket metrics ──────────────────────────────────────────────────────────

export const wsConnectionsActive = new client.Gauge({
  name: 'x402_ws_connections_active',
  help: 'Number of active WebSocket connections',
});

export const wsMessagesTotal = new client.Counter({
  name: 'x402_ws_messages_total',
  help: 'Total WebSocket messages broadcast',
  labelNames: ['channel'],
});

// ── Risk control metrics ───────────────────────────────────────────────────────

export const riskCheckDuration = new client.Histogram({
  name: 'x402_risk_check_duration_seconds',
  help: 'Risk control check round-trip duration',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
});

export const riskRateLimited = new client.Counter({
  name: 'x402_risk_rate_limited_total',
  help: 'Total requests blocked by risk rate limiting',
});

export const registry = client.register;
