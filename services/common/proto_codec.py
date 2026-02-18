from __future__ import annotations

import importlib
import sys
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from google.protobuf.timestamp_pb2 import Timestamp


def _compile_protos(proto_dir: Path, generated_dir: Path) -> None:
    from grpc_tools import protoc
    from pkg_resources import resource_filename

    generated_dir.mkdir(parents=True, exist_ok=True)
    includes = resource_filename('grpc_tools', '_proto')
    result = protoc.main(
        [
            'grpc_tools.protoc',
            f'-I{proto_dir}',
            f'-I{includes}',
            f'--python_out={generated_dir}',
            str(proto_dir / 'dex_tx_raw.proto'),
            str(proto_dir / 'dex_tx_valid.proto'),
            str(proto_dir / 'dex_ledger_entry_batch.proto')
        ]
    )
    if result != 0:
        raise RuntimeError(f'protobuf compilation failed with code={result}')


def _import_generated(generated_dir: Path, module_name: str) -> Any:
    if str(generated_dir) not in sys.path:
        sys.path.insert(0, str(generated_dir))
    return importlib.import_module(module_name)


class ProtoBundle:
    def __init__(self, generated_dir: Path) -> None:
        self.dex_tx_raw_pb2 = _import_generated(generated_dir, 'dex_tx_raw_pb2')
        self.dex_tx_valid_pb2 = _import_generated(generated_dir, 'dex_tx_valid_pb2')
        self.dex_ledger_entry_batch_pb2 = _import_generated(generated_dir, 'dex_ledger_entry_batch_pb2')


@lru_cache(maxsize=1)
def load_proto_bundle() -> ProtoBundle:
    repo_root = Path(__file__).resolve().parents[2]
    proto_dir = repo_root / 'packages' / 'proto'
    generated_dir = Path('/tmp/mcryptoex_protos')

    _compile_protos(proto_dir=proto_dir, generated_dir=generated_dir)
    return ProtoBundle(generated_dir=generated_dir)


def now_ts() -> Timestamp:
    ts = Timestamp()
    ts.FromDatetime(datetime.now(timezone.utc))
    return ts
