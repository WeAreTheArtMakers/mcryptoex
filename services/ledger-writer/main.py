from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import clickhouse_connect
import psycopg2
from confluent_kafka import Consumer, Producer
from psycopg2.extras import execute_values

from services.common.proto_codec import load_proto_bundle, now_ts

LOGGER = logging.getLogger('mcryptoex.ledger_writer')


@dataclass
class Settings:
    service_name: str
    kafka_bootstrap_servers: str
    group_id: str
    dex_tx_valid_topic: str
    dex_ledger_entries_topic: str
    dex_outbox_topic: str
    postgres_dsn: str
    clickhouse_host: str
    clickhouse_port: int
    clickhouse_user: str
    clickhouse_password: str
    clickhouse_database: str



def _settings_from_env() -> Settings:
    return Settings(
        service_name=os.getenv('SERVICE_NAME', 'ledger-writer'),
        kafka_bootstrap_servers=os.getenv('KAFKA_BOOTSTRAP_SERVERS', 'redpanda:9092'),
        group_id=os.getenv('LEDGER_WRITER_GROUP_ID', 'mcryptoex-ledger-writer-v1'),
        dex_tx_valid_topic=os.getenv('DEX_TX_VALID_TOPIC', 'dex_tx_valid'),
        dex_ledger_entries_topic=os.getenv('DEX_LEDGER_ENTRIES_TOPIC', 'dex_ledger_entries'),
        dex_outbox_topic=os.getenv('DEX_OUTBOX_TOPIC', 'dex_outbox'),
        postgres_dsn=os.getenv('POSTGRES_DSN', 'postgresql://mcryptoex:mcryptoex@postgres:5432/mcryptoex'),
        clickhouse_host=os.getenv('CLICKHOUSE_HOST', 'clickhouse'),
        clickhouse_port=int(os.getenv('CLICKHOUSE_PORT', '8123')),
        clickhouse_user=os.getenv('CLICKHOUSE_USER', 'default'),
        clickhouse_password=os.getenv('CLICKHOUSE_PASSWORD', 'mcryptoex'),
        clickhouse_database=os.getenv('CLICKHOUSE_DATABASE', 'mcryptoex')
    )


def _dec(value: str) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError):
        return Decimal('0')


def _ts_from_proto(proto_ts) -> datetime:
    dt = proto_ts.ToDatetime()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


class LedgerWriter:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.proto = load_proto_bundle()

        self.consumer = Consumer(
            {
                'bootstrap.servers': settings.kafka_bootstrap_servers,
                'group.id': settings.group_id,
                'enable.auto.commit': False,
                'auto.offset.reset': 'earliest'
            }
        )
        self.producer = Producer(
            {
                'bootstrap.servers': settings.kafka_bootstrap_servers,
                'client.id': f"{settings.service_name}-producer"
            }
        )

        self.pg_conn = psycopg2.connect(settings.postgres_dsn)
        self.pg_conn.autocommit = False

        self.ch = clickhouse_connect.get_client(
            host=settings.clickhouse_host,
            port=settings.clickhouse_port,
            username=settings.clickhouse_user,
            password=settings.clickhouse_password,
            database=settings.clickhouse_database
        )

    def run(self) -> None:
        self.consumer.subscribe([self.settings.dex_tx_valid_topic])
        LOGGER.info('ledger writer subscribed topic=%s', self.settings.dex_tx_valid_topic)

        while True:
            message = self.consumer.poll(1.0)
            if message is None:
                continue
            if message.error():
                LOGGER.error('consumer error: %s', message.error())
                continue

            try:
                valid = self.proto.dex_tx_valid_pb2.DexTxValid()
                valid.ParseFromString(message.value())

                inserted, ledger_rows, outbox_payload = self._persist(valid)
                if inserted:
                    self._publish_ledger_batch(valid, ledger_rows)
                    self._publish_outbox(outbox_payload)
                    self._write_clickhouse(valid)

                self.consumer.commit(message=message, asynchronous=False)
                LOGGER.info('ledger write complete note_id=%s tx_id=%s inserted=%s', valid.note_id, valid.tx_id, inserted)
            except Exception:
                LOGGER.exception('failed to process valid note')

    def _persist(self, valid) -> tuple[bool, list[dict], dict]:
        occurred_at = _ts_from_proto(valid.occurred_at)
        ingested_at = datetime.now(timezone.utc)

        amount_in = _dec(valid.amount_in)
        amount_out = _dec(valid.amount_out)
        fee_usd = _dec(valid.fee_usd)
        gas_used = _dec(valid.gas_used)
        gas_cost_usd = _dec(valid.gas_cost_usd)
        protocol_revenue_usd = _dec(valid.protocol_revenue_usd)
        min_out = _dec(valid.min_out)

        ledger_rows = self._build_ledger_rows(
            tx_id=valid.tx_id,
            note_id=valid.note_id,
            chain_id=valid.chain_id,
            tx_hash=valid.tx_hash,
            action=valid.action,
            user_address=valid.user_address,
            pool_address=valid.pool_address,
            token_in=valid.token_in,
            token_out=valid.token_out,
            amount_in=amount_in,
            amount_out=amount_out,
            fee_usd=fee_usd,
            gas_cost_usd=gas_cost_usd,
            protocol_revenue_usd=protocol_revenue_usd,
            occurred_at=occurred_at
        )

        outbox_payload = {
            'event_type': 'dex.note.ingested',
            'tx_id': valid.tx_id,
            'note_id': valid.note_id,
            'chain_id': valid.chain_id,
            'tx_hash': valid.tx_hash,
            'action': valid.action,
            'occurred_at': occurred_at.isoformat()
        }

        with self.pg_conn.cursor() as cur:
            cur.execute(
                '''
                INSERT INTO dex_transactions (
                  tx_id,
                  note_id,
                  correlation_id,
                  chain_id,
                  tx_hash,
                  action,
                  user_address,
                  pool_address,
                  token_in,
                  token_out,
                  amount_in,
                  amount_out,
                  fee_usd,
                  gas_used,
                  gas_cost_usd,
                  protocol_revenue_usd,
                  min_out,
                  block_number,
                  occurred_at,
                  ingested_at
                )
                VALUES (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                ON CONFLICT (note_id) DO NOTHING
                RETURNING tx_id
                ''',
                (
                    valid.tx_id,
                    valid.note_id,
                    valid.correlation_id,
                    valid.chain_id,
                    valid.tx_hash,
                    valid.action,
                    valid.user_address,
                    valid.pool_address,
                    valid.token_in,
                    valid.token_out,
                    amount_in,
                    amount_out,
                    fee_usd,
                    gas_used,
                    gas_cost_usd,
                    protocol_revenue_usd,
                    min_out,
                    valid.block_number,
                    occurred_at,
                    ingested_at
                )
            )
            row = cur.fetchone()
            inserted = row is not None

            if inserted and ledger_rows:
                execute_values(
                    cur,
                    '''
                    INSERT INTO dex_ledger_entries (
                      tx_id,
                      note_id,
                      chain_id,
                      tx_hash,
                      account_id,
                      side,
                      asset,
                      amount,
                      entry_type,
                      fee_usd,
                      gas_cost_usd,
                      protocol_revenue_usd,
                      pool_address,
                      occurred_at
                    )
                    VALUES %s
                    ''',
                    [
                        (
                            row_item['tx_id'],
                            row_item['note_id'],
                            row_item['chain_id'],
                            row_item['tx_hash'],
                            row_item['account_id'],
                            row_item['side'],
                            row_item['asset'],
                            row_item['amount'],
                            row_item['entry_type'],
                            row_item['fee_usd'],
                            row_item['gas_cost_usd'],
                            row_item['protocol_revenue_usd'],
                            row_item['pool_address'],
                            row_item['occurred_at']
                        )
                        for row_item in ledger_rows
                    ]
                )

            if inserted:
                cur.execute(
                    '''
                    INSERT INTO dex_outbox (
                      tx_id,
                      event_type,
                      payload,
                      published,
                      created_at
                    )
                    VALUES (%s, %s, %s::jsonb, FALSE, NOW())
                    ''',
                    (valid.tx_id, 'dex.note.ingested', json.dumps(outbox_payload))
                )

        self.pg_conn.commit()
        return inserted, ledger_rows, outbox_payload

    def _build_ledger_rows(
        self,
        *,
        tx_id: str,
        note_id: str,
        chain_id: int,
        tx_hash: str,
        action: str,
        user_address: str,
        pool_address: str,
        token_in: str,
        token_out: str,
        amount_in: Decimal,
        amount_out: Decimal,
        fee_usd: Decimal,
        gas_cost_usd: Decimal,
        protocol_revenue_usd: Decimal,
        occurred_at: datetime
    ) -> list[dict]:
        rows: list[dict] = []

        def add_pair(entry_type: str, debit_account: str, credit_account: str, asset: str, amount: Decimal) -> None:
            if amount <= 0:
                return

            base = {
                'tx_id': tx_id,
                'note_id': note_id,
                'chain_id': chain_id,
                'tx_hash': tx_hash,
                'asset': asset,
                'amount': amount,
                'entry_type': entry_type,
                'fee_usd': fee_usd,
                'gas_cost_usd': gas_cost_usd,
                'protocol_revenue_usd': protocol_revenue_usd,
                'pool_address': pool_address,
                'occurred_at': occurred_at
            }

            rows.append(
                {
                    **base,
                    'account_id': debit_account,
                    'side': 'debit'
                }
            )
            rows.append(
                {
                    **base,
                    'account_id': credit_account,
                    'side': 'credit'
                }
            )

        user_account = f'user:{user_address.lower()}'
        pool_account = f'pool:{pool_address.lower()}'

        if action == 'SWAP':
            add_pair('swap_notional_in', user_account, pool_account, token_in, amount_in)
            add_pair('swap_notional_out', pool_account, user_account, token_out, amount_out)
            add_pair('trade_fee_usd', user_account, 'protocol:treasury', 'USD', fee_usd)
            add_pair('protocol_revenue_usd', pool_account, 'protocol:treasury', 'USD', protocol_revenue_usd)
            add_pair('gas_cost_usd', user_account, f'network:{chain_id}', 'USD', gas_cost_usd)
            return rows

        if action == 'LIQUIDITY_ADD':
            add_pair('liquidity_add_in_a', user_account, pool_account, token_in, amount_in)
            add_pair('liquidity_add_in_b', user_account, pool_account, token_out, amount_out)
            add_pair('gas_cost_usd', user_account, f'network:{chain_id}', 'USD', gas_cost_usd)
            return rows

        if action == 'LIQUIDITY_REMOVE':
            add_pair('liquidity_remove_out_a', pool_account, user_account, token_in, amount_in)
            add_pair('liquidity_remove_out_b', pool_account, user_account, token_out, amount_out)
            add_pair('gas_cost_usd', user_account, f'network:{chain_id}', 'USD', gas_cost_usd)
            return rows

        if action == 'MUSD_MINT':
            add_pair('musd_mint_collateral', user_account, pool_account, token_in, amount_in)
            add_pair('musd_mint_issue', pool_account, user_account, token_out, amount_out)
            add_pair('gas_cost_usd', user_account, f'network:{chain_id}', 'USD', gas_cost_usd)
            return rows

        if action == 'MUSD_BURN':
            add_pair('musd_burn_in', user_account, pool_account, token_in, amount_in)
            add_pair('musd_burn_redeem', pool_account, user_account, token_out, amount_out)
            add_pair('gas_cost_usd', user_account, f'network:{chain_id}', 'USD', gas_cost_usd)
            return rows

        if action == 'FEE_TRANSFERRED_TO_TREASURY':
            add_pair('fee_transfer_to_treasury', pool_account, 'protocol:treasury', token_in, amount_in)
            return rows

        if action == 'TREASURY_CONVERTED_TO_MUSD':
            add_pair('treasury_convert_spend', 'protocol:conversion', 'protocol:treasury', token_in, amount_in)
            add_pair('treasury_convert_receive', 'protocol:treasury', 'protocol:conversion', token_out, amount_out)
            return rows

        if action == 'DISTRIBUTION_EXECUTED':
            add_pair('treasury_distribution', user_account, 'protocol:treasury', 'mUSD', amount_in)
            return rows

        return rows

    def _publish_ledger_batch(self, valid, ledger_rows: list[dict]) -> None:
        batch = self.proto.dex_ledger_entry_batch_pb2.DexLedgerEntryBatch(
            batch_id=str(uuid.uuid4()),
            tx_id=valid.tx_id,
            note_id=valid.note_id,
            correlation_id=valid.correlation_id,
            chain_id=valid.chain_id,
            tx_hash=valid.tx_hash
        )
        batch.created_at.CopyFrom(now_ts())

        for row in ledger_rows:
            item = batch.entries.add()
            item.tx_id = row['tx_id']
            item.note_id = row['note_id']
            item.chain_id = row['chain_id']
            item.tx_hash = row['tx_hash']
            item.account_id = row['account_id']
            item.side = row['side']
            item.asset = row['asset']
            item.amount = format(row['amount'], 'f')
            item.entry_type = row['entry_type']
            item.fee_usd = format(row['fee_usd'], 'f')
            item.gas_cost_usd = format(row['gas_cost_usd'], 'f')
            item.protocol_revenue_usd = format(row['protocol_revenue_usd'], 'f')
            item.pool_address = row['pool_address']
            item.occurred_at.FromDatetime(row['occurred_at'])

        self.producer.produce(
            topic=self.settings.dex_ledger_entries_topic,
            key=valid.note_id,
            value=batch.SerializeToString(),
            headers=[('correlation_id', valid.correlation_id.encode('utf-8'))]
        )
        self.producer.poll(0)

    def _publish_outbox(self, payload: dict) -> None:
        self.producer.produce(
            topic=self.settings.dex_outbox_topic,
            key=payload['note_id'],
            value=json.dumps(payload).encode('utf-8')
        )
        self.producer.poll(0)

    def _write_clickhouse(self, valid) -> None:
        occurred_at = _ts_from_proto(valid.occurred_at)

        self.ch.insert(
            f"{self.settings.clickhouse_database}.dex_transactions_raw",
            [
                [
                    valid.tx_id,
                    valid.note_id,
                    int(valid.chain_id),
                    valid.tx_hash,
                    valid.action,
                    valid.user_address,
                    valid.pool_address,
                    valid.token_in,
                    valid.token_out,
                    _dec(valid.amount_in),
                    _dec(valid.amount_out),
                    _dec(valid.fee_usd),
                    int(_dec(valid.gas_used)),
                    _dec(valid.gas_cost_usd),
                    _dec(valid.protocol_revenue_usd),
                    _dec(valid.min_out),
                    occurred_at,
                    datetime.now(timezone.utc)
                ]
            ],
            column_names=[
                'tx_id',
                'note_id',
                'chain_id',
                'tx_hash',
                'action',
                'user_address',
                'pool_address',
                'token_in',
                'token_out',
                'amount_in',
                'amount_out',
                'fee_usd',
                'gas_used',
                'gas_cost_usd',
                'protocol_revenue_usd',
                'min_out',
                'occurred_at',
                'ingested_at'
            ]
        )


def main() -> None:
    logging.basicConfig(
        level=os.getenv('LOG_LEVEL', 'INFO').upper(),
        format='%(asctime)s %(levelname)s [%(name)s] %(message)s'
    )
    settings = _settings_from_env()
    LedgerWriter(settings).run()


if __name__ == '__main__':
    main()
