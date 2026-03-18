-- x402Trade Database Schema
-- Migration 001: Initial schema

-- agents 表
CREATE TABLE IF NOT EXISTS agents (
    id SERIAL PRIMARY KEY,
    wallet_address VARCHAR(42) UNIQUE NOT NULL,
    score INTEGER DEFAULT 100 CHECK (score >= 0 AND score <= 100),
    stake_usdc DECIMAL(18,6) DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    is_blacklisted BOOLEAN DEFAULT false,
    last_active_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_wallet ON agents(wallet_address);
CREATE INDEX IF NOT EXISTS idx_agents_score ON agents(score);
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(is_active);

-- balances 表 (one-to-one with agents)
CREATE TABLE IF NOT EXISTS balances (
    id SERIAL PRIMARY KEY,
    agent_id INTEGER REFERENCES agents(id) UNIQUE NOT NULL,
    usdc_balance DECIMAL(36,6) DEFAULT 0 CHECK (usdc_balance >= 0),
    usdc_locked DECIMAL(36,6) DEFAULT 0 CHECK (usdc_locked >= 0),
    eth_balance DECIMAL(36,18) DEFAULT 0 CHECK (eth_balance >= 0),
    eth_locked DECIMAL(36,18) DEFAULT 0 CHECK (eth_locked >= 0),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_balances_agent ON balances(agent_id);

-- orders 表
CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    order_id VARCHAR(64) UNIQUE NOT NULL,
    agent_id INTEGER REFERENCES agents(id) NOT NULL,
    pair VARCHAR(20) NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
    order_type VARCHAR(10) NOT NULL CHECK (order_type IN ('limit', 'market')),
    amount DECIMAL(18,6) NOT NULL CHECK (amount > 0),
    price DECIMAL(36,18) NOT NULL,
    filled_amount DECIMAL(18,6) DEFAULT 0 CHECK (filled_amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'filled', 'cancelled')),
    fee_usdc DECIMAL(18,6) DEFAULT 0,
    gas_used DECIMAL(36,18) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    filled_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_agent ON orders(agent_id);
CREATE INDEX IF NOT EXISTS idx_orders_pair ON orders(pair);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_pair_status ON orders(pair, status);

-- trades 表 (completed fills)
CREATE TABLE IF NOT EXISTS trades (
    id BIGSERIAL PRIMARY KEY,
    trade_id VARCHAR(64) UNIQUE NOT NULL,
    agent_id INTEGER REFERENCES agents(id) NOT NULL,
    order_id VARCHAR(64) REFERENCES orders(order_id) NOT NULL,
    pair VARCHAR(20) NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
    amount DECIMAL(18,6) NOT NULL CHECK (amount > 0),
    price DECIMAL(36,18) NOT NULL,
    fee_usdc DECIMAL(18,6) NOT NULL DEFAULT 0,
    gas_used DECIMAL(36,18) NOT NULL DEFAULT 0,
    tx_hash VARCHAR(66),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_agent ON trades(agent_id);
CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_order ON trades(order_id);

-- payments 表 (x402 payment records + deposits + withdrawals)
CREATE TABLE IF NOT EXISTS payments (
    id BIGSERIAL PRIMARY KEY,
    payment_hash VARCHAR(66) UNIQUE NOT NULL,
    agent_id INTEGER REFERENCES agents(id),
    endpoint VARCHAR(100) NOT NULL,
    amount DECIMAL(18,6) NOT NULL,
    token_address VARCHAR(42) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
    confirmed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_agent ON payments(agent_id);
CREATE INDEX IF NOT EXISTS idx_payments_hash ON payments(payment_hash);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- activity_log 表
CREATE TABLE IF NOT EXISTS activity_log (
    id BIGSERIAL PRIMARY KEY,
    agent_id INTEGER REFERENCES agents(id),
    action_type VARCHAR(50) NOT NULL CHECK (action_type IN ('trade', 'deposit', 'withdraw', 'api_call', 'register')),
    endpoint VARCHAR(100),
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(action_type);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC);

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
