from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from confluent_kafka import Consumer, Producer

from services.common.proto_codec import load_proto_bundle

LOGGER = logging.getLogger('mcryptoex.validator')

ALLOWED_ACTIONS = {
    'SWAP',
    'LIQUIDITY_ADD',
    'LIQUIDITY_REMOVE',
    'MUSD_MINT',
    'MUSD_BURN',
    'PROTOCOL_FEE_ACCRUED',
    'FEE_TRANSFERRED_TO_TREASURY',
    'TREASURY_CONVERTED_TO_MUSD',
    'DISTRIBUTION_EXECUTED'
}


@dataclass
class Settings:
    service_name: str
    kafka_bootstrap_servers: str
    group_id: str
    dex_tx_raw_topic: str
    dex_tx_valid_topic: str
    dex_dlq_topic: str



def _settings_from_env() -> Settings:
    return Settings(
        service_name=os.getenv('SERVICE_NAME', 'validator'),
        kafka_bootstrap_servers=os.getenv('KAFKA_BOOTSTRAP_SERVERS', 'redpanda:9092'),
        group_id=os.getenv('VALIDATOR_GROUP_ID', 'mcryptoex-validator-v1'),
        dex_tx_raw_topic=os.getenv('DEX_TX_RAW_TOPIC', 'dex_tx_raw'),
        dex_tx_valid_topic=os.getenv('DEX_TX_VALID_TOPIC', 'dex_tx_valid'),
        dex_dlq_topic=os.getenv('DEX_DLQ_TOPIC', 'dex_dlq')
    )


class NotesValidator:
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

    def run(self) -> None:
        self.consumer.subscribe([self.settings.dex_tx_raw_topic])
        LOGGER.info('validator subscribed topic=%s', self.settings.dex_tx_raw_topic)

        while True:
            message = self.consumer.poll(1.0)
            if message is None:
                continue

            if message.error():
                LOGGER.error('consumer error: %s', message.error())
                continue

            try:
                raw = self.proto.dex_tx_raw_pb2.DexTxRaw()
                raw.ParseFromString(message.value())

                valid = self._validate(raw)
                self.producer.produce(
                    topic=self.settings.dex_tx_valid_topic,
                    key=valid.note_id,
                    value=valid.SerializeToString(),
                    headers=[('correlation_id', valid.correlation_id.encode('utf-8'))]
                )
                self.producer.poll(0)

                self.consumer.commit(message=message, asynchronous=False)
                LOGGER.info('validated note_id=%s action=%s tx_hash=%s', valid.note_id, valid.action, valid.tx_hash)
            except Exception as exc:
                self._publish_dlq(message.value(), error=str(exc))
                self.consumer.commit(message=message, asynchronous=False)
                LOGGER.exception('note validation failed: %s', exc)

    def _validate(self, raw) -> object:
        required_fields = [
            'note_id',
            'correlation_id',
            'tx_hash',
            'action',
            'user_address',
            'pool_address',
            'token_in',
            'token_out'
        ]
        for field in required_fields:
            value = getattr(raw, field)
            if not str(value).strip():
                raise ValueError(f'missing field: {field}')

        if raw.chain_id <= 0:
            raise ValueError('chain_id must be > 0')

        if raw.action not in ALLOWED_ACTIONS:
            raise ValueError(f'unsupported action: {raw.action}')

        self._validate_decimal(raw.amount_in, 'amount_in', allow_zero=True)
        self._validate_decimal(raw.amount_out, 'amount_out', allow_zero=True)
        self._validate_decimal(raw.fee_usd, 'fee_usd', allow_zero=True)
        self._validate_decimal(raw.gas_used, 'gas_used', allow_zero=True)
        self._validate_decimal(raw.gas_cost_usd, 'gas_cost_usd', allow_zero=True)
        self._validate_decimal(raw.protocol_revenue_usd, 'protocol_revenue_usd', allow_zero=True)
        min_out = str(raw.min_out).strip() or '0'
        self._validate_decimal(min_out, 'min_out', allow_zero=True)

        tx_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{raw.chain_id}:{raw.tx_hash}:{raw.note_id}"))
        valid = self.proto.dex_tx_valid_pb2.DexTxValid(
            tx_id=tx_id,
            note_id=raw.note_id,
            correlation_id=raw.correlation_id,
            chain_id=raw.chain_id,
            tx_hash=raw.tx_hash,
            action=raw.action,
            user_address=raw.user_address,
            pool_address=raw.pool_address,
            token_in=raw.token_in,
            token_out=raw.token_out,
            amount_in=raw.amount_in,
            amount_out=raw.amount_out,
            fee_usd=raw.fee_usd,
            gas_used=raw.gas_used,
            gas_cost_usd=raw.gas_cost_usd,
            protocol_revenue_usd=raw.protocol_revenue_usd,
            block_number=raw.block_number,
            validation_version='v1',
            min_out=min_out
        )

        if raw.HasField('occurred_at'):
            valid.occurred_at.CopyFrom(raw.occurred_at)
        else:
            valid.occurred_at.FromDatetime(datetime.now(timezone.utc))

        return valid

    @staticmethod
    def _validate_decimal(value: str, field: str, allow_zero: bool) -> None:
        try:
            parsed = Decimal(str(value))
        except (InvalidOperation, TypeError) as exc:
            raise ValueError(f'invalid decimal field {field}: {value}') from exc

        if parsed < 0:
            raise ValueError(f'{field} must be >= 0')
        if not allow_zero and parsed == 0:
            raise ValueError(f'{field} must be > 0')

    def _publish_dlq(self, payload: bytes, error: str) -> None:
        message = {
            'error': error,
            'payload_hex': payload.hex()
        }
        self.producer.produce(
            topic=self.settings.dex_dlq_topic,
            key=str(uuid.uuid4()),
            value=json.dumps(message).encode('utf-8')
        )
        self.producer.poll(0)


def main() -> None:
    logging.basicConfig(
        level=os.getenv('LOG_LEVEL', 'INFO').upper(),
        format='%(asctime)s %(levelname)s [%(name)s] %(message)s'
    )
    settings = _settings_from_env()
    NotesValidator(settings).run()


if __name__ == '__main__':
    main()
