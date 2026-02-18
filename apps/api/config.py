from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', case_sensitive=False)

    app_name: str = 'mcryptoex-tempo-api'
    environment: Literal['dev', 'prod', 'test'] = 'dev'
    cors_origins: str = 'http://localhost:3300'

    postgres_dsn: str = 'postgresql://mcryptoex:mcryptoex@postgres:5432/mcryptoex'
    kafka_bootstrap_servers: str = 'redpanda:9092'
    clickhouse_host: str = 'clickhouse'
    clickhouse_port: int = 8123
    clickhouse_username: str = 'default'
    clickhouse_password: str = 'mcryptoex'
    clickhouse_database: str = 'mcryptoex'

    dex_tx_raw_topic: str = 'dex_tx_raw'


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
