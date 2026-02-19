from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import asyncpg
import clickhouse_connect
from confluent_kafka import Producer
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
from prometheus_client import Counter, make_asgi_app
from pydantic import BaseModel, Field

from .chain_registry import load_chain_registry, risk_assumptions_payload, tokens_payload
from .compliance import enforce_optional_compliance
from .config import get_settings
from .proto_codec import ProtoCodec
from .quote_engine import QuoteEngineError, build_quote

settings = get_settings()

NOTES_PUBLISHED_TOTAL = Counter(
    'mcryptoex_notes_published_total',
    'Published raw notes from API',
    ['action', 'chain_id']
)

app = FastAPI(title=settings.app_name, default_response_class=ORJSONResponse)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[x.strip() for x in settings.cors_origins.split(',') if x.strip()],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*']
)
app.mount('/metrics', make_asgi_app())

_pg_pool: asyncpg.Pool | None = None
_ch = None
_producer: Producer | None = None
_codec: ProtoCodec | None = None


class EmitSwapRequest(BaseModel):
    chain_id: int = 31337
    tx_hash: str = Field(default_factory=lambda: f"0x{uuid.uuid4().hex}{uuid.uuid4().hex[:32]}")
    user_address: str = os.getenv('DEBUG_EMIT_USER_ADDRESS', '0x1000000000000000000000000000000000000001')
    pool_address: str = '0x1111111111111111111111111111111111111111'
    token_in: str = 'mUSD'
    token_out: str = 'WETH'
    amount_in: str = '100.0'
    amount_out: str = '0.03'
    fee_usd: str = '0.30'
    gas_used: str = '117104'
    gas_cost_usd: str = '0.22'
    protocol_revenue_usd: str = '0.12'
    min_out: str = '0'
    block_number: int = 1
    action: str = 'SWAP'


@app.on_event('startup')
async def startup() -> None:
    global _pg_pool, _ch, _producer, _codec
    _pg_pool = await asyncpg.create_pool(dsn=settings.postgres_dsn, min_size=1, max_size=10)
    _ch = clickhouse_connect.get_client(
        host=settings.clickhouse_host,
        port=settings.clickhouse_port,
        username=settings.clickhouse_username,
        password=settings.clickhouse_password,
        database=settings.clickhouse_database
    )
    _producer = Producer(
        {
            'bootstrap.servers': settings.kafka_bootstrap_servers,
            'client.id': 'mcryptoex-tempo-api'
        }
    )
    _codec = ProtoCodec()


@app.on_event('shutdown')
async def shutdown() -> None:
    global _pg_pool, _ch, _producer
    if _producer is not None:
        _producer.flush(5)
    if _pg_pool is not None:
        await _pg_pool.close()
    if _ch is not None:
        _ch.close()


@app.get('/health')
async def health() -> dict[str, str]:
    return {'status': 'ok'}


@app.get('/health/ready')
async def ready() -> dict[str, str]:
    assert _pg_pool is not None
    assert _ch is not None
    async with _pg_pool.acquire() as conn:
        await conn.fetchval('SELECT 1')
    _ch.query('SELECT 1')
    return {'status': 'ready'}


@app.get('/tokens')
async def tokens() -> dict:
    return tokens_payload()


@app.get('/risk/assumptions')
async def risk_assumptions(chain_id: int = Query(..., gt=0)) -> dict:
    payload = risk_assumptions_payload(chain_id)
    if payload is None:
        raise HTTPException(status_code=404, detail=f'chain_id={chain_id} not found in registry')
    return payload


@app.get('/quote')
async def quote(
    chain_id: int,
    token_in: str,
    token_out: str,
    amount_in: Decimal,
    slippage_bps: int = Query(default=50, ge=1, le=3000),
    wallet_address: str | None = Query(default=None),
    country_code: str | None = Query(default=None, min_length=2, max_length=2)
) -> dict:
    enforce_optional_compliance(country_code=country_code, wallet_address=wallet_address)
    try:
        return build_quote(
            chain_id=chain_id,
            token_in=token_in,
            token_out=token_out,
            amount_in=amount_in,
            slippage_bps=slippage_bps
        )
    except QuoteEngineError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@app.get('/pairs')
async def pairs(
    chain_id: int | None = Query(default=None, gt=0),
    limit: int = Query(default=100, ge=1, le=1000)
) -> dict:
    assert _pg_pool is not None
    registry = load_chain_registry()
    registry_pairs: dict[tuple[int, str], dict] = {}

    for chain in registry.get('chains', []):
        try:
            item_chain_id = int(chain.get('chain_id', 0))
        except (TypeError, ValueError):
            continue
        if item_chain_id <= 0:
            continue
        if chain_id is not None and item_chain_id != chain_id:
            continue

        for pair in chain.get('pairs', []):
            if not isinstance(pair, dict):
                continue
            pool_address = str(pair.get('pair_address', '')).strip().lower()
            if not pool_address:
                continue
            registry_pairs[(item_chain_id, pool_address)] = {
                'chain_id': item_chain_id,
                'pool_address': pool_address,
                'token0_symbol': str(pair.get('token0_symbol', '')).strip(),
                'token1_symbol': str(pair.get('token1_symbol', '')).strip(),
                'token0_address': str(pair.get('token0_address', '')).strip(),
                'token1_address': str(pair.get('token1_address', '')).strip(),
                'reserve0_decimal': str(pair.get('reserve0_decimal', '0')),
                'reserve1_decimal': str(pair.get('reserve1_decimal', '0')),
                'checked_at': pair.get('checked_at')
            }

    sql_filter = ''
    params: list = []
    if chain_id is not None:
        sql_filter = 'WHERE chain_id = $1'
        params.append(chain_id)

    stats_limit = min(max(limit * 8, 500), 5000)
    params.append(stats_limit)

    async with _pg_pool.acquire() as conn:
        stats_rows = await conn.fetch(
            '''
            SELECT
              chain_id,
              lower(pool_address) AS pool_address,
              min(token_in) AS token_in,
              min(token_out) AS token_out,
              COUNT(*) AS swaps,
              SUM(amount_in)::text AS total_amount_in,
              SUM(amount_out)::text AS total_amount_out,
              SUM(fee_usd)::text AS total_fee_usd,
              MAX(occurred_at) AS last_swap_at
            FROM dex_transactions
            '''
            + sql_filter
            + '''
            GROUP BY chain_id, lower(pool_address)
            ORDER BY MAX(occurred_at) DESC NULLS LAST, COUNT(*) DESC
            LIMIT $'''
            + str(len(params))
            ,
            *params
        )

    stats_map: dict[tuple[int, str], dict] = {}
    for row in stats_rows:
        key = (int(row['chain_id']), str(row['pool_address']).lower())
        stats_map[key] = {
            'chain_id': int(row['chain_id']),
            'pool_address': str(row['pool_address']).lower(),
            'token_in': str(row['token_in']),
            'token_out': str(row['token_out']),
            'swaps': int(row['swaps']),
            'total_amount_in': str(row['total_amount_in']),
            'total_amount_out': str(row['total_amount_out']),
            'total_fee_usd': str(row['total_fee_usd']),
            'last_swap_at': row['last_swap_at']
        }

    merged: list[dict] = []
    for key, pair in registry_pairs.items():
        stat = stats_map.pop(key, None)
        merged.append(
            {
                'chain_id': pair['chain_id'],
                'pool_address': pair['pool_address'],
                'token0_symbol': pair['token0_symbol'],
                'token1_symbol': pair['token1_symbol'],
                'token0_address': pair['token0_address'],
                'token1_address': pair['token1_address'],
                'reserve0_decimal': pair['reserve0_decimal'],
                'reserve1_decimal': pair['reserve1_decimal'],
                'swaps': int(stat['swaps']) if stat else 0,
                'total_amount_in': stat['total_amount_in'] if stat else '0',
                'total_amount_out': stat['total_amount_out'] if stat else '0',
                'total_fee_usd': stat['total_fee_usd'] if stat else '0',
                'last_swap_at': stat['last_swap_at'] if stat else None,
                'checked_at': pair['checked_at'],
                'source': 'registry+ledger' if stat else 'registry'
            }
        )

    for (_, _pool_address), stat in stats_map.items():
        merged.append(
            {
                'chain_id': stat['chain_id'],
                'pool_address': stat['pool_address'],
                'token0_symbol': stat['token_in'],
                'token1_symbol': stat['token_out'],
                'token0_address': '',
                'token1_address': '',
                'reserve0_decimal': '0',
                'reserve1_decimal': '0',
                'swaps': int(stat['swaps']),
                'total_amount_in': stat['total_amount_in'],
                'total_amount_out': stat['total_amount_out'],
                'total_fee_usd': stat['total_fee_usd'],
                'last_swap_at': stat['last_swap_at'],
                'checked_at': None,
                'source': 'ledger'
            }
        )

    merged.sort(
        key=lambda row: (
            int(row['swaps']),
            row.get('last_swap_at') or datetime.fromtimestamp(0, tz=timezone.utc)
        ),
        reverse=True
    )
    return {'rows': merged[:limit]}


@app.get('/ledger/recent')
async def ledger_recent(
    limit: int = Query(default=100, ge=1, le=2000),
    chain_id: int | None = Query(default=None, gt=0),
    entry_type: str | None = Query(default=None)
) -> dict:
    assert _pg_pool is not None
    filters: list[str] = []
    params: list = []

    if chain_id is not None:
        params.append(chain_id)
        filters.append(f'chain_id = ${len(params)}')

    if entry_type is not None and entry_type.strip():
        params.append(entry_type.strip())
        filters.append(f'entry_type = ${len(params)}')

    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ''
    params.append(limit)

    async with _pg_pool.acquire() as conn:
        rows = await conn.fetch(
            '''
            SELECT
              entry_id,
              tx_id::text,
              note_id,
              chain_id,
              tx_hash,
              account_id,
              side,
              asset,
              amount::text,
              entry_type,
              fee_usd::text,
              gas_cost_usd::text,
              protocol_revenue_usd::text,
              pool_address,
              occurred_at,
              created_at
            FROM dex_ledger_entries
            '''
            + where_clause
            + '''
            ORDER BY entry_id DESC
            LIMIT $'''
            + str(len(params))
            ,
            *params
        )
    return {'rows': [dict(r) for r in rows]}


@app.get('/analytics')
async def analytics(minutes: int = Query(default=60, ge=1, le=43200)) -> dict:
    assert _ch is not None

    volume = _ch.query(
        '''
        SELECT bucket, chain_id, asset, sum(volume) as volume
        FROM mcryptoex.dex_volume_by_chain_token_1m
        WHERE bucket >= now() - toIntervalMinute(%(minutes)s)
        GROUP BY bucket, chain_id, asset
        ORDER BY bucket ASC
        ''',
        parameters={'minutes': minutes}
    )

    fees = _ch.query(
        '''
        SELECT bucket, chain_id, sum(revenue_usd) as revenue_usd
        FROM mcryptoex.dex_fee_revenue_1m
        WHERE bucket >= now() - toIntervalMinute(%(minutes)s)
        GROUP BY bucket, chain_id
        ORDER BY bucket ASC
        ''',
        parameters={'minutes': minutes}
    )

    gas = _ch.query(
        '''
        SELECT
          bucket,
          chain_id,
          sum(gas_cost_sum) / nullIf(sum(gas_cost_count), 0) as avg_gas_cost_usd
        FROM mcryptoex.dex_gas_cost_rollup_1m
        WHERE bucket >= now() - toIntervalMinute(%(minutes)s)
        GROUP BY bucket, chain_id
        ORDER BY bucket ASC
        ''',
        parameters={'minutes': minutes}
    )

    fee_breakdown = _ch.query(
        '''
        SELECT
          bucket,
          chain_id,
          pool_address,
          token,
          sum(fee_amount) AS fee_amount
        FROM mcryptoex.dex_fee_breakdown_1m
        WHERE bucket >= now() - toIntervalMinute(%(minutes)s)
        GROUP BY bucket, chain_id, pool_address, token
        ORDER BY bucket ASC
        ''',
        parameters={'minutes': minutes}
    )

    musd_revenue_daily = _ch.query(
        '''
        SELECT
          bucket,
          chain_id,
          sum(revenue_musd) AS revenue_musd
        FROM mcryptoex.dex_protocol_revenue_musd_1d
        WHERE bucket >= toDate(now() - toIntervalDay(30))
        GROUP BY bucket, chain_id
        ORDER BY bucket ASC
        '''
    )

    conversion_slippage = _ch.query(
        '''
        SELECT
          bucket,
          chain_id,
          (sum(slippage_numerator) / nullIf(sum(min_out_sum), 0)) * 10000 AS slippage_bps,
          sum(conversion_count) AS conversions
        FROM mcryptoex.dex_conversion_slippage_rollup_1m
        WHERE bucket >= now() - toIntervalMinute(%(minutes)s)
        GROUP BY bucket, chain_id
        ORDER BY bucket ASC
        ''',
        parameters={'minutes': minutes}
    )

    def as_dicts(res):
        payload = []
        for row in res.result_rows:
            item = {}
            for key, value in zip(res.column_names, row):
                if isinstance(value, Decimal):
                    item[key] = str(value)
                elif isinstance(value, datetime):
                    item[key] = value.isoformat()
                else:
                    item[key] = value
            payload.append(item)
        return payload

    return {
        'minutes': minutes,
        'volume_by_chain_token': as_dicts(volume),
        'fee_revenue': as_dicts(fees),
        'gas_cost_averages': as_dicts(gas),
        'fee_breakdown_by_pool_token': as_dicts(fee_breakdown),
        'protocol_revenue_musd_daily': as_dicts(musd_revenue_daily),
        'conversion_slippage': as_dicts(conversion_slippage)
    }


@app.post('/debug/emit-swap-note')
async def emit_swap_note(req: EmitSwapRequest) -> dict:
    assert _producer is not None and _codec is not None
    enforce_optional_compliance(wallet_address=req.user_address)

    note_id = str(uuid.uuid4())
    correlation_id = str(uuid.uuid4())

    msg = _codec.dex_tx_raw_pb2.DexTxRaw(
        note_id=note_id,
        correlation_id=correlation_id,
        chain_id=req.chain_id,
        tx_hash=req.tx_hash,
        action=req.action,
        user_address=req.user_address,
        pool_address=req.pool_address,
        token_in=req.token_in,
        token_out=req.token_out,
        amount_in=req.amount_in,
        amount_out=req.amount_out,
        fee_usd=req.fee_usd,
        gas_used=req.gas_used,
        gas_cost_usd=req.gas_cost_usd,
        protocol_revenue_usd=req.protocol_revenue_usd,
        min_out=req.min_out,
        block_number=req.block_number,
        source='tempo-api-debug'
    )
    msg.occurred_at.CopyFrom(_codec.now_ts())

    payload = msg.SerializeToString()
    _producer.produce(
        topic=settings.dex_tx_raw_topic,
        key=note_id,
        value=payload,
        headers={'correlation_id': correlation_id}
    )
    _producer.flush(5)

    NOTES_PUBLISHED_TOTAL.labels(action=req.action, chain_id=str(req.chain_id)).inc()

    return {
        'status': 'accepted',
        'note_id': note_id,
        'correlation_id': correlation_id,
        'topic': settings.dex_tx_raw_topic,
        'published_at': datetime.now(timezone.utc).isoformat()
    }


@app.get('/')
async def root() -> dict:
    return {'service': settings.app_name, 'status': 'ok'}
