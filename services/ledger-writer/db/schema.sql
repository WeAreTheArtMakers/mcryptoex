CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS dex_transactions (
    tx_id UUID PRIMARY KEY,
    note_id TEXT NOT NULL UNIQUE,
    correlation_id TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    action TEXT NOT NULL,
    user_address TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    token_in TEXT NOT NULL,
    token_out TEXT NOT NULL,
    amount_in NUMERIC(78, 18) NOT NULL,
    amount_out NUMERIC(78, 18) NOT NULL,
    fee_usd NUMERIC(78, 18) NOT NULL DEFAULT 0,
    gas_used NUMERIC(78, 0) NOT NULL DEFAULT 0,
    gas_cost_usd NUMERIC(78, 18) NOT NULL DEFAULT 0,
    protocol_revenue_usd NUMERIC(78, 18) NOT NULL DEFAULT 0,
    block_number BIGINT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dex_transactions_chain_occurred
    ON dex_transactions (chain_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_dex_transactions_action_occurred
    ON dex_transactions (action, occurred_at DESC);

CREATE TABLE IF NOT EXISTS dex_ledger_entries (
    entry_id BIGSERIAL PRIMARY KEY,
    tx_id UUID NOT NULL REFERENCES dex_transactions(tx_id) ON DELETE CASCADE,
    note_id TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    account_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
    asset TEXT NOT NULL,
    amount NUMERIC(78, 18) NOT NULL,
    entry_type TEXT NOT NULL,
    fee_usd NUMERIC(78, 18) NOT NULL DEFAULT 0,
    gas_cost_usd NUMERIC(78, 18) NOT NULL DEFAULT 0,
    protocol_revenue_usd NUMERIC(78, 18) NOT NULL DEFAULT 0,
    pool_address TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dex_ledger_entries_tx_id ON dex_ledger_entries (tx_id);
CREATE INDEX IF NOT EXISTS idx_dex_ledger_entries_note_id ON dex_ledger_entries (note_id);
CREATE INDEX IF NOT EXISTS idx_dex_ledger_entries_occurred ON dex_ledger_entries (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_dex_ledger_entries_account ON dex_ledger_entries (account_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS dex_outbox (
    outbox_id BIGSERIAL PRIMARY KEY,
    tx_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    published BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dex_outbox_pending ON dex_outbox (published, created_at);
