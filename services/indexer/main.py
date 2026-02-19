from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, getcontext
from pathlib import Path
from typing import Any

from confluent_kafka import Producer
from eth_abi import decode
from web3 import Web3

from services.common.proto_codec import load_proto_bundle

getcontext().prec = 78

LOGGER = logging.getLogger('mcryptoex.indexer')

PAIR_ABI = [
    {
        'inputs': [],
        'name': 'token0',
        'outputs': [{'internalType': 'address', 'name': '', 'type': 'address'}],
        'stateMutability': 'view',
        'type': 'function'
    },
    {
        'inputs': [],
        'name': 'token1',
        'outputs': [{'internalType': 'address', 'name': '', 'type': 'address'}],
        'stateMutability': 'view',
        'type': 'function'
    }
]

ERC20_META_ABI = [
    {
        'inputs': [],
        'name': 'symbol',
        'outputs': [{'internalType': 'string', 'name': '', 'type': 'string'}],
        'stateMutability': 'view',
        'type': 'function'
    },
    {
        'inputs': [],
        'name': 'decimals',
        'outputs': [{'internalType': 'uint8', 'name': '', 'type': 'uint8'}],
        'stateMutability': 'view',
        'type': 'function'
    }
]


@dataclass
class Settings:
    service_name: str
    kafka_bootstrap_servers: str
    dex_tx_raw_topic: str
    chain_key: str
    chain_id: int
    rpc_url: str
    pair_addresses: list[str]
    stabilizer_addresses: list[str]
    poll_interval_seconds: int
    start_block: int | None
    confirmation_depth: int
    native_usd_price: Decimal
    swap_fee_bps: int
    protocol_revenue_share_bps: int
    enable_simulation: bool
    simulation_interval_seconds: int
    registry_refresh_seconds: int
    pair_addresses_overridden: bool
    stabilizer_addresses_overridden: bool


@dataclass
class PairMeta:
    token0: str
    token1: str
    token0_symbol: str
    token1_symbol: str
    token0_decimals: int
    token1_decimals: int


def _csv_env(name: str) -> list[str]:
    raw = os.getenv(name, '').strip()
    if not raw:
        return []
    return [part.strip() for part in raw.split(',') if part.strip()]


def _normalize_addresses(values: list[str]) -> list[str]:
    normalized: list[str] = []
    for value in values:
        candidate = str(value).strip()
        if not candidate:
            continue
        if not Web3.is_address(candidate):
            continue
        normalized.append(Web3.to_checksum_address(candidate))
    return normalized


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _registry_path() -> Path:
    configured = os.getenv('CHAIN_REGISTRY_PATH', 'packages/sdk/data/chain-registry.generated.json')
    path = Path(configured)
    if path.is_absolute():
        return path
    return _repo_root() / path


def _load_chain_from_registry(chain_key: str) -> dict[str, Any]:
    path = _registry_path()
    if not path.exists():
        return {}

    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except json.JSONDecodeError:
        return {}

    chains = payload.get('chains', [])
    if not isinstance(chains, list):
        return {}

    for chain in chains:
        if str(chain.get('chain_key', '')).strip() == chain_key:
            return chain if isinstance(chain, dict) else {}
    return {}


def _registry_addresses(chain: dict[str, Any], key: str) -> list[str]:
    indexer_cfg = chain.get('indexer', {})
    if not isinstance(indexer_cfg, dict):
        return []
    value = indexer_cfg.get(key, [])
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _settings_from_env() -> Settings:
    chain_key = os.getenv('INDEXER_CHAIN_KEY', 'hardhat-local').strip()
    chain_from_registry = _load_chain_from_registry(chain_key)
    indexer_cfg = chain_from_registry.get('indexer', {}) if isinstance(chain_from_registry, dict) else {}

    start_block_default = 'latest'
    if isinstance(indexer_cfg, dict):
        start_block_default = str(indexer_cfg.get('start_block', 'latest'))

    start_block_env = os.getenv('INDEXER_START_BLOCK', start_block_default).strip().lower()
    start_block: int | None
    if start_block_env in {'', 'latest'}:
        start_block = None
    else:
        start_block = int(start_block_env)

    chain_id_default = 31337
    if isinstance(chain_from_registry, dict):
        try:
            chain_id_default = int(chain_from_registry.get('chain_id', 31337))
        except (TypeError, ValueError):
            chain_id_default = 31337

    rpc_env_key = ''
    default_rpc_url = ''
    if isinstance(chain_from_registry, dict):
        rpc_env_key = str(chain_from_registry.get('rpc_env_key', '')).strip()
        default_rpc_url = str(chain_from_registry.get('default_rpc_url', '')).strip()

    rpc_from_chain_env = os.getenv(rpc_env_key, '').strip() if rpc_env_key else ''
    rpc_url = os.getenv('INDEXER_RPC_URL', '').strip() or rpc_from_chain_env or default_rpc_url

    registry_pairs = _registry_addresses(chain_from_registry, 'pair_addresses')
    registry_stabilizers = _registry_addresses(chain_from_registry, 'stabilizer_addresses')

    pair_override_raw = os.getenv('INDEXER_PAIR_ADDRESSES', '').strip()
    pair_addresses_overridden = bool(pair_override_raw)
    pair_addresses = _csv_env('INDEXER_PAIR_ADDRESSES')
    if not pair_addresses_overridden and registry_pairs:
        pair_addresses = registry_pairs
    pair_addresses = _normalize_addresses(pair_addresses)

    stabilizer_override_raw = os.getenv('INDEXER_STABILIZER_ADDRESSES', '').strip()
    stabilizer_addresses_overridden = bool(stabilizer_override_raw)
    stabilizer_addresses = _csv_env('INDEXER_STABILIZER_ADDRESSES')
    if not stabilizer_addresses_overridden and registry_stabilizers:
        stabilizer_addresses = registry_stabilizers
    stabilizer_addresses = _normalize_addresses(stabilizer_addresses)

    confirmation_depth_default = 0
    if isinstance(indexer_cfg, dict):
        try:
            confirmation_depth_default = int(indexer_cfg.get('confirmation_depth', 0))
        except (TypeError, ValueError):
            confirmation_depth_default = 0

    return Settings(
        service_name=os.getenv('SERVICE_NAME', 'indexer'),
        kafka_bootstrap_servers=os.getenv('KAFKA_BOOTSTRAP_SERVERS', 'redpanda:9092'),
        dex_tx_raw_topic=os.getenv('DEX_TX_RAW_TOPIC', 'dex_tx_raw'),
        chain_key=chain_key,
        chain_id=int(os.getenv('INDEXER_CHAIN_ID', str(chain_id_default))),
        rpc_url=rpc_url,
        pair_addresses=pair_addresses,
        stabilizer_addresses=stabilizer_addresses,
        poll_interval_seconds=int(os.getenv('INDEXER_POLL_INTERVAL_SECONDS', '5')),
        start_block=start_block,
        confirmation_depth=int(os.getenv('INDEXER_CONFIRMATION_DEPTH', str(confirmation_depth_default))),
        native_usd_price=Decimal(os.getenv('INDEXER_NATIVE_USD_PRICE', '3300')),
        swap_fee_bps=int(os.getenv('INDEXER_SWAP_FEE_BPS', '30')),
        protocol_revenue_share_bps=int(os.getenv('INDEXER_PROTOCOL_REVENUE_SHARE_BPS', '4000')),
        enable_simulation=os.getenv('INDEXER_ENABLE_SIMULATION', 'false').lower() == 'true',
        simulation_interval_seconds=int(os.getenv('INDEXER_SIMULATION_INTERVAL_SECONDS', '20')),
        registry_refresh_seconds=int(os.getenv('INDEXER_REGISTRY_REFRESH_SECONDS', '30')),
        pair_addresses_overridden=pair_addresses_overridden,
        stabilizer_addresses_overridden=stabilizer_addresses_overridden
    )


def _topic_to_address(topic: Any) -> str:
    hex_topic = topic.hex() if hasattr(topic, 'hex') else str(topic)
    return Web3.to_checksum_address(f"0x{hex_topic[-40:]}")


def _to_decimal_str(raw_amount: int, decimals: int) -> str:
    if decimals < 0:
        decimals = 0
    amount = Decimal(raw_amount) / (Decimal(10) ** decimals)
    return format(amount, 'f')


def _to_timestamp(seconds: int):
    return datetime.fromtimestamp(seconds, tz=timezone.utc)


def _hex_prefixed(value: Any) -> str:
    raw = value.hex() if hasattr(value, 'hex') else str(value)
    if raw.startswith('0x'):
        return raw
    return f'0x{raw}'


class ChainIndexer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.proto = load_proto_bundle()
        self.producer = Producer(
            {
                'bootstrap.servers': settings.kafka_bootstrap_servers,
                'client.id': f"mcryptoex-indexer-{settings.chain_id}"
            }
        )
        self.web3: Web3 | None = None
        self.current_block: int | None = settings.start_block

        self.swap_topic = _hex_prefixed(Web3.keccak(text='Swap(address,uint256,uint256,uint256,uint256,address)'))
        self.mint_topic = _hex_prefixed(Web3.keccak(text='Mint(address,uint256,uint256)'))
        self.burn_topic = _hex_prefixed(Web3.keccak(text='Burn(address,uint256,uint256,address)'))
        self.note_minted_topic = _hex_prefixed(
            Web3.keccak(text='NoteMinted(address,address,uint256,uint256,uint256,address)')
        )
        self.note_burned_topic = _hex_prefixed(
            Web3.keccak(text='NoteBurned(address,address,uint256,uint256,uint256,address)')
        )

        self._pair_meta_cache: dict[str, PairMeta] = {}
        self._token_meta_cache: dict[str, tuple[str, int]] = {}
        self._tx_cost_cache: dict[str, tuple[str, str]] = {}
        self._block_ts_cache: dict[int, datetime] = {}
        self._last_simulated_at = 0.0
        self._last_registry_refresh_at = 0.0

    def run(self) -> None:
        LOGGER.info(
            'starting service=%s chain_key=%s chain_id=%s pair_count=%s stabilizer_count=%s',
            self.settings.service_name,
            self.settings.chain_key,
            self.settings.chain_id,
            len(self.settings.pair_addresses),
            len(self.settings.stabilizer_addresses)
        )

        if self.settings.rpc_url:
            self.web3 = Web3(Web3.HTTPProvider(self.settings.rpc_url, request_kwargs={'timeout': 10}))
            if not self.web3.is_connected():
                LOGGER.warning('rpc is not reachable at %s; running in idle/simulation mode', self.settings.rpc_url)
                self.web3 = None
        else:
            LOGGER.info('INDEXER_RPC_URL not set; running in idle/simulation mode')

        while True:
            try:
                self._refresh_registry_watchlists()
                if self.web3 is not None and (self.settings.pair_addresses or self.settings.stabilizer_addresses):
                    self._poll_chain_once()
                self._maybe_emit_simulated_note()
            except Exception:
                LOGGER.exception('indexer loop failed')
                time.sleep(max(1, self.settings.poll_interval_seconds))

            self.producer.poll(0)
            time.sleep(max(1, self.settings.poll_interval_seconds))

    def _refresh_registry_watchlists(self, force: bool = False) -> None:
        if self.settings.pair_addresses_overridden and self.settings.stabilizer_addresses_overridden:
            return
        if self.settings.registry_refresh_seconds <= 0 and not force:
            return

        now = time.time()
        if not force and now - self._last_registry_refresh_at < self.settings.registry_refresh_seconds:
            return
        self._last_registry_refresh_at = now

        chain_from_registry = _load_chain_from_registry(self.settings.chain_key)
        if not chain_from_registry:
            return

        indexer_cfg = chain_from_registry.get('indexer', {})
        if not isinstance(indexer_cfg, dict):
            return

        if not self.settings.pair_addresses_overridden:
            registry_pairs = _normalize_addresses(_registry_addresses(chain_from_registry, 'pair_addresses'))
            if registry_pairs != self.settings.pair_addresses:
                LOGGER.info(
                    'updating pair watchlist chain_key=%s old=%s new=%s',
                    self.settings.chain_key,
                    len(self.settings.pair_addresses),
                    len(registry_pairs)
                )
                self.settings.pair_addresses = registry_pairs
                self._pair_meta_cache.clear()

        if not self.settings.stabilizer_addresses_overridden:
            registry_stabilizers = _normalize_addresses(_registry_addresses(chain_from_registry, 'stabilizer_addresses'))
            if registry_stabilizers != self.settings.stabilizer_addresses:
                LOGGER.info(
                    'updating stabilizer watchlist chain_key=%s old=%s new=%s',
                    self.settings.chain_key,
                    len(self.settings.stabilizer_addresses),
                    len(registry_stabilizers)
                )
                self.settings.stabilizer_addresses = registry_stabilizers

    def _poll_chain_once(self) -> None:
        assert self.web3 is not None

        latest = self.web3.eth.block_number - self.settings.confirmation_depth
        if latest < 0:
            return

        if self.current_block is None:
            self.current_block = latest

        if self.current_block > latest:
            return

        from_block = self.current_block
        to_block = min(latest, from_block + 100)

        if self.settings.pair_addresses:
            self._poll_pair_events(from_block=from_block, to_block=to_block)

        if self.settings.stabilizer_addresses:
            self._poll_stabilizer_events(from_block=from_block, to_block=to_block)

        self.current_block = to_block + 1

    def _poll_pair_events(self, from_block: int, to_block: int) -> None:
        assert self.web3 is not None

        logs = self.web3.eth.get_logs(
            {
                'fromBlock': from_block,
                'toBlock': to_block,
                'address': [Web3.to_checksum_address(x) for x in self.settings.pair_addresses],
                'topics': [[self.swap_topic, self.mint_topic, self.burn_topic]]
            }
        )

        for log in logs:
            topic0 = _hex_prefixed(log['topics'][0])
            if topic0 == self.swap_topic:
                self._handle_swap_log(log)
            elif topic0 == self.mint_topic:
                self._handle_liquidity_add_log(log)
            elif topic0 == self.burn_topic:
                self._handle_liquidity_remove_log(log)

    def _poll_stabilizer_events(self, from_block: int, to_block: int) -> None:
        assert self.web3 is not None

        logs = self.web3.eth.get_logs(
            {
                'fromBlock': from_block,
                'toBlock': to_block,
                'address': [Web3.to_checksum_address(x) for x in self.settings.stabilizer_addresses],
                'topics': [[self.note_minted_topic, self.note_burned_topic]]
            }
        )

        for log in logs:
            topic0 = _hex_prefixed(log['topics'][0])
            if topic0 == self.note_minted_topic:
                self._handle_musd_mint_log(log)
            elif topic0 == self.note_burned_topic:
                self._handle_musd_burn_log(log)

    def _maybe_emit_simulated_note(self) -> None:
        if not self.settings.enable_simulation:
            return

        now = time.time()
        if now - self._last_simulated_at < self.settings.simulation_interval_seconds:
            return

        self._last_simulated_at = now
        tx_hash = f"0x{uuid.uuid4().hex}{uuid.uuid4().hex[:32]}"
        note_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"sim:{self.settings.chain_id}:{tx_hash}"))
        correlation_id = str(uuid.uuid4())

        note = self.proto.dex_tx_raw_pb2.DexTxRaw(
            note_id=note_id,
            correlation_id=correlation_id,
            chain_id=self.settings.chain_id,
            tx_hash=tx_hash,
            action='SWAP',
            user_address='0x00000000000000000000000000000000000000AA',
            pool_address='0x00000000000000000000000000000000000000BB',
            token_in='mUSD',
            token_out='WETH',
            amount_in='100.0',
            amount_out='0.03',
            fee_usd='0.3',
            gas_used='117104',
            gas_cost_usd='0.22',
            protocol_revenue_usd='0.12',
            block_number=0,
            source='indexer-simulation'
        )
        note.occurred_at.FromDatetime(datetime.now(timezone.utc))

        self.producer.produce(
            topic=self.settings.dex_tx_raw_topic,
            key=note.note_id,
            value=note.SerializeToString(),
            headers=[('correlation_id', correlation_id.encode('utf-8'))]
        )
        LOGGER.info('simulated raw note published note_id=%s', note.note_id)

    def _handle_swap_log(self, log: Any) -> None:
        pair = Web3.to_checksum_address(log['address'])
        meta = self._pair_meta(pair)

        amount0_in, amount1_in, amount0_out, amount1_out = decode(
            ['uint256', 'uint256', 'uint256', 'uint256'],
            bytes(log['data'])
        )

        if amount0_in > 0:
            token_in, token_in_decimals = meta.token0_symbol, meta.token0_decimals
            amount_in_raw = amount0_in
        else:
            token_in, token_in_decimals = meta.token1_symbol, meta.token1_decimals
            amount_in_raw = amount1_in

        if amount0_out > 0:
            token_out, token_out_decimals = meta.token0_symbol, meta.token0_decimals
            amount_out_raw = amount0_out
        else:
            token_out, token_out_decimals = meta.token1_symbol, meta.token1_decimals
            amount_out_raw = amount1_out

        amount_in = Decimal(_to_decimal_str(amount_in_raw, token_in_decimals))
        amount_out = Decimal(_to_decimal_str(amount_out_raw, token_out_decimals))

        fee_usd = Decimal('0')
        if token_in.upper() == 'MUSD':
            fee_usd = (amount_in * Decimal(self.settings.swap_fee_bps)) / Decimal(10_000)
        protocol_revenue = (fee_usd * Decimal(self.settings.protocol_revenue_share_bps)) / Decimal(10_000)

        tx_hash = log['transactionHash'].hex()
        gas_used, gas_cost_usd = self._tx_gas_metrics(tx_hash)

        sender = _topic_to_address(log['topics'][1])
        block_ts = self._block_timestamp(log['blockNumber'])

        self._publish_raw_note(
            action='SWAP',
            tx_hash=tx_hash,
            block_number=log['blockNumber'],
            log_index=log['logIndex'],
            user_address=sender,
            pool_address=pair,
            token_in=token_in,
            token_out=token_out,
            amount_in=format(amount_in, 'f'),
            amount_out=format(amount_out, 'f'),
            fee_usd=format(fee_usd, 'f'),
            gas_used=gas_used,
            gas_cost_usd=gas_cost_usd,
            protocol_revenue_usd=format(protocol_revenue, 'f'),
            occurred_at=block_ts,
            source='chain-indexer'
        )

    def _handle_liquidity_add_log(self, log: Any) -> None:
        pair = Web3.to_checksum_address(log['address'])
        meta = self._pair_meta(pair)

        amount0, amount1 = decode(['uint256', 'uint256'], bytes(log['data']))
        user = _topic_to_address(log['topics'][1])
        tx_hash = log['transactionHash'].hex()
        gas_used, gas_cost_usd = self._tx_gas_metrics(tx_hash)

        self._publish_raw_note(
            action='LIQUIDITY_ADD',
            tx_hash=tx_hash,
            block_number=log['blockNumber'],
            log_index=log['logIndex'],
            user_address=user,
            pool_address=pair,
            token_in=meta.token0_symbol,
            token_out=meta.token1_symbol,
            amount_in=_to_decimal_str(amount0, meta.token0_decimals),
            amount_out=_to_decimal_str(amount1, meta.token1_decimals),
            fee_usd='0',
            gas_used=gas_used,
            gas_cost_usd=gas_cost_usd,
            protocol_revenue_usd='0',
            occurred_at=self._block_timestamp(log['blockNumber']),
            source='chain-indexer'
        )

    def _handle_liquidity_remove_log(self, log: Any) -> None:
        pair = Web3.to_checksum_address(log['address'])
        meta = self._pair_meta(pair)

        amount0, amount1 = decode(['uint256', 'uint256'], bytes(log['data']))
        user = _topic_to_address(log['topics'][1])
        tx_hash = log['transactionHash'].hex()
        gas_used, gas_cost_usd = self._tx_gas_metrics(tx_hash)

        self._publish_raw_note(
            action='LIQUIDITY_REMOVE',
            tx_hash=tx_hash,
            block_number=log['blockNumber'],
            log_index=log['logIndex'],
            user_address=user,
            pool_address=pair,
            token_in=meta.token0_symbol,
            token_out=meta.token1_symbol,
            amount_in=_to_decimal_str(amount0, meta.token0_decimals),
            amount_out=_to_decimal_str(amount1, meta.token1_decimals),
            fee_usd='0',
            gas_used=gas_used,
            gas_cost_usd=gas_cost_usd,
            protocol_revenue_usd='0',
            occurred_at=self._block_timestamp(log['blockNumber']),
            source='chain-indexer'
        )

    def _handle_musd_mint_log(self, log: Any) -> None:
        user = _topic_to_address(log['topics'][1])
        collateral_token = _topic_to_address(log['topics'][2])

        collateral_in, musd_out, _price, _recipient = decode(
            ['uint256', 'uint256', 'uint256', 'address'],
            bytes(log['data'])
        )

        collateral_symbol, collateral_decimals = self._token_meta(collateral_token)
        tx_hash = log['transactionHash'].hex()
        gas_used, gas_cost_usd = self._tx_gas_metrics(tx_hash)

        self._publish_raw_note(
            action='MUSD_MINT',
            tx_hash=tx_hash,
            block_number=log['blockNumber'],
            log_index=log['logIndex'],
            user_address=user,
            pool_address=Web3.to_checksum_address(log['address']),
            token_in=collateral_symbol,
            token_out='mUSD',
            amount_in=_to_decimal_str(collateral_in, collateral_decimals),
            amount_out=_to_decimal_str(musd_out, 18),
            fee_usd='0',
            gas_used=gas_used,
            gas_cost_usd=gas_cost_usd,
            protocol_revenue_usd='0',
            occurred_at=self._block_timestamp(log['blockNumber']),
            source='chain-indexer'
        )

    def _handle_musd_burn_log(self, log: Any) -> None:
        user = _topic_to_address(log['topics'][1])
        collateral_token = _topic_to_address(log['topics'][2])

        musd_in, collateral_out, _price, _recipient = decode(
            ['uint256', 'uint256', 'uint256', 'address'],
            bytes(log['data'])
        )

        collateral_symbol, collateral_decimals = self._token_meta(collateral_token)
        tx_hash = log['transactionHash'].hex()
        gas_used, gas_cost_usd = self._tx_gas_metrics(tx_hash)

        self._publish_raw_note(
            action='MUSD_BURN',
            tx_hash=tx_hash,
            block_number=log['blockNumber'],
            log_index=log['logIndex'],
            user_address=user,
            pool_address=Web3.to_checksum_address(log['address']),
            token_in='mUSD',
            token_out=collateral_symbol,
            amount_in=_to_decimal_str(musd_in, 18),
            amount_out=_to_decimal_str(collateral_out, collateral_decimals),
            fee_usd='0',
            gas_used=gas_used,
            gas_cost_usd=gas_cost_usd,
            protocol_revenue_usd='0',
            occurred_at=self._block_timestamp(log['blockNumber']),
            source='chain-indexer'
        )

    def _publish_raw_note(
        self,
        *,
        action: str,
        tx_hash: str,
        block_number: int,
        log_index: int,
        user_address: str,
        pool_address: str,
        token_in: str,
        token_out: str,
        amount_in: str,
        amount_out: str,
        fee_usd: str,
        gas_used: str,
        gas_cost_usd: str,
        protocol_revenue_usd: str,
        occurred_at: datetime,
        source: str
    ) -> None:
        note_key = f"{self.settings.chain_id}:{tx_hash}:{log_index}:{action}"
        note_id = str(uuid.uuid5(uuid.NAMESPACE_URL, note_key))
        correlation_id = str(uuid.uuid4())

        note = self.proto.dex_tx_raw_pb2.DexTxRaw(
            note_id=note_id,
            correlation_id=correlation_id,
            chain_id=self.settings.chain_id,
            tx_hash=tx_hash,
            action=action,
            user_address=user_address,
            pool_address=pool_address,
            token_in=token_in,
            token_out=token_out,
            amount_in=amount_in,
            amount_out=amount_out,
            fee_usd=fee_usd,
            gas_used=gas_used,
            gas_cost_usd=gas_cost_usd,
            protocol_revenue_usd=protocol_revenue_usd,
            block_number=block_number,
            source=source
        )
        note.occurred_at.FromDatetime(occurred_at)

        self.producer.produce(
            topic=self.settings.dex_tx_raw_topic,
            key=note.note_id,
            value=note.SerializeToString(),
            headers=[('correlation_id', correlation_id.encode('utf-8'))]
        )
        LOGGER.info(
            'raw note published action=%s note_id=%s tx_hash=%s block=%s',
            action,
            note_id,
            tx_hash,
            block_number
        )

    def _pair_meta(self, pair_address: str) -> PairMeta:
        if pair_address in self._pair_meta_cache:
            return self._pair_meta_cache[pair_address]

        assert self.web3 is not None
        pair = self.web3.eth.contract(address=pair_address, abi=PAIR_ABI)

        token0 = Web3.to_checksum_address(pair.functions.token0().call())
        token1 = Web3.to_checksum_address(pair.functions.token1().call())

        token0_symbol, token0_decimals = self._token_meta(token0)
        token1_symbol, token1_decimals = self._token_meta(token1)

        meta = PairMeta(
            token0=token0,
            token1=token1,
            token0_symbol=token0_symbol,
            token1_symbol=token1_symbol,
            token0_decimals=token0_decimals,
            token1_decimals=token1_decimals
        )
        self._pair_meta_cache[pair_address] = meta
        return meta

    def _token_meta(self, token_address: str) -> tuple[str, int]:
        if token_address in self._token_meta_cache:
            return self._token_meta_cache[token_address]

        assert self.web3 is not None
        token = self.web3.eth.contract(address=token_address, abi=ERC20_META_ABI)
        symbol = token.functions.symbol().call()
        decimals = int(token.functions.decimals().call())

        self._token_meta_cache[token_address] = (symbol, decimals)
        return symbol, decimals

    def _tx_gas_metrics(self, tx_hash: str) -> tuple[str, str]:
        if tx_hash in self._tx_cost_cache:
            return self._tx_cost_cache[tx_hash]

        gas_used_str = '0'
        gas_cost_usd_str = '0'

        if self.web3 is not None:
            receipt = self.web3.eth.get_transaction_receipt(tx_hash)
            gas_used = int(receipt['gasUsed'])
            effective_price = receipt.get('effectiveGasPrice')
            if effective_price is None:
                tx = self.web3.eth.get_transaction(tx_hash)
                effective_price = tx.get('gasPrice', 0)

            gas_native = (Decimal(gas_used) * Decimal(int(effective_price))) / (Decimal(10) ** 18)
            gas_cost_usd = gas_native * self.settings.native_usd_price

            gas_used_str = str(gas_used)
            gas_cost_usd_str = format(gas_cost_usd, 'f')

        self._tx_cost_cache[tx_hash] = (gas_used_str, gas_cost_usd_str)
        return gas_used_str, gas_cost_usd_str

    def _block_timestamp(self, block_number: int) -> datetime:
        if block_number in self._block_ts_cache:
            return self._block_ts_cache[block_number]

        assert self.web3 is not None
        block = self.web3.eth.get_block(block_number)
        ts = _to_timestamp(int(block['timestamp']))
        self._block_ts_cache[block_number] = ts
        return ts


def main() -> None:
    logging.basicConfig(
        level=os.getenv('LOG_LEVEL', 'INFO').upper(),
        format='%(asctime)s %(levelname)s [%(name)s] %(message)s'
    )
    settings = _settings_from_env()
    ChainIndexer(settings).run()


if __name__ == '__main__':
    main()
