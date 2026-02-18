from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {'1', 'true', 'yes', 'y', 'on'}


@dataclass(frozen=True)
class Settings:
    app_name: str
    environment: Literal['dev', 'prod', 'test']
    cors_origins: str
    postgres_dsn: str
    kafka_bootstrap_servers: str
    clickhouse_host: str
    clickhouse_port: int
    clickhouse_username: str
    clickhouse_password: str
    clickhouse_database: str
    dex_tx_raw_topic: str
    compliance_enforcement_enabled: bool
    compliance_blocked_countries: str
    compliance_sanctions_blocked_wallets: str


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    environment = os.getenv('ENVIRONMENT', 'dev').strip().lower()
    if environment not in {'dev', 'prod', 'test'}:
        environment = 'dev'

    return Settings(
        app_name=os.getenv('APP_NAME', 'mcryptoex-tempo-api'),
        environment=environment,  # type: ignore[arg-type]
        cors_origins=os.getenv('CORS_ORIGINS', 'http://localhost:3300'),
        postgres_dsn=os.getenv('POSTGRES_DSN', 'postgresql://mcryptoex:mcryptoex@postgres:5432/mcryptoex'),
        kafka_bootstrap_servers=os.getenv('KAFKA_BOOTSTRAP_SERVERS', 'redpanda:9092'),
        clickhouse_host=os.getenv('CLICKHOUSE_HOST', 'clickhouse'),
        clickhouse_port=int(os.getenv('CLICKHOUSE_PORT', '8123')),
        clickhouse_username=os.getenv('CLICKHOUSE_USERNAME', 'default'),
        clickhouse_password=os.getenv('CLICKHOUSE_PASSWORD', 'mcryptoex'),
        clickhouse_database=os.getenv('CLICKHOUSE_DATABASE', 'mcryptoex'),
        dex_tx_raw_topic=os.getenv('DEX_TX_RAW_TOPIC', 'dex_tx_raw'),
        compliance_enforcement_enabled=_env_bool('COMPLIANCE_ENFORCEMENT_ENABLED', False),
        compliance_blocked_countries=os.getenv('COMPLIANCE_BLOCKED_COUNTRIES', ''),
        compliance_sanctions_blocked_wallets=os.getenv('COMPLIANCE_SANCTIONS_BLOCKED_WALLETS', '')
    )
