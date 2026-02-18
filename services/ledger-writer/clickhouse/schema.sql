CREATE DATABASE IF NOT EXISTS mcryptoex;

CREATE TABLE IF NOT EXISTS mcryptoex.dex_transactions_raw
(
    tx_id String,
    note_id String,
    chain_id UInt32,
    tx_hash String,
    action LowCardinality(String),
    user_address String,
    pool_address String,
    token_in LowCardinality(String),
    token_out LowCardinality(String),
    amount_in Decimal(38, 18),
    amount_out Decimal(38, 18),
    fee_usd Decimal(38, 18),
    gas_used UInt64,
    gas_cost_usd Decimal(38, 18),
    protocol_revenue_usd Decimal(38, 18),
    occurred_at DateTime64(3),
    ingested_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (occurred_at, chain_id, tx_id);

CREATE TABLE IF NOT EXISTS mcryptoex.dex_volume_by_chain_token_1m
(
    bucket DateTime,
    chain_id UInt32,
    asset LowCardinality(String),
    volume Decimal(38, 18)
)
ENGINE = SummingMergeTree
ORDER BY (bucket, chain_id, asset);

CREATE MATERIALIZED VIEW IF NOT EXISTS mcryptoex.mv_dex_volume_in_1m
TO mcryptoex.dex_volume_by_chain_token_1m
AS
SELECT
    toStartOfMinute(occurred_at) AS bucket,
    chain_id,
    token_in AS asset,
    amount_in AS volume
FROM mcryptoex.dex_transactions_raw
WHERE amount_in > 0;

CREATE MATERIALIZED VIEW IF NOT EXISTS mcryptoex.mv_dex_volume_out_1m
TO mcryptoex.dex_volume_by_chain_token_1m
AS
SELECT
    toStartOfMinute(occurred_at) AS bucket,
    chain_id,
    token_out AS asset,
    amount_out AS volume
FROM mcryptoex.dex_transactions_raw
WHERE amount_out > 0;

CREATE TABLE IF NOT EXISTS mcryptoex.dex_fee_revenue_1m
(
    bucket DateTime,
    chain_id UInt32,
    revenue_usd Decimal(38, 18)
)
ENGINE = SummingMergeTree
ORDER BY (bucket, chain_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mcryptoex.mv_dex_fee_revenue_1m
TO mcryptoex.dex_fee_revenue_1m
AS
SELECT
    toStartOfMinute(occurred_at) AS bucket,
    chain_id,
    protocol_revenue_usd AS revenue_usd
FROM mcryptoex.dex_transactions_raw
WHERE protocol_revenue_usd > 0;

CREATE TABLE IF NOT EXISTS mcryptoex.dex_gas_cost_rollup_1m
(
    bucket DateTime,
    chain_id UInt32,
    gas_cost_sum Decimal(38, 18),
    gas_cost_count UInt64
)
ENGINE = SummingMergeTree
ORDER BY (bucket, chain_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mcryptoex.mv_dex_gas_cost_rollup_1m
TO mcryptoex.dex_gas_cost_rollup_1m
AS
SELECT
    toStartOfMinute(occurred_at) AS bucket,
    chain_id,
    gas_cost_usd AS gas_cost_sum,
    toUInt64(1) AS gas_cost_count
FROM mcryptoex.dex_transactions_raw
WHERE gas_cost_usd >= 0;
