from __future__ import annotations

import importlib
import sys
from datetime import datetime, timezone
from pathlib import Path

from google.protobuf.timestamp_pb2 import Timestamp


class ProtoCodec:
    def __init__(self) -> None:
        self.dex_tx_raw_pb2 = self._load_proto('dex_tx_raw_pb2')

    def _load_proto(self, module_name: str):
        generated_dir = Path(__file__).resolve().parent / 'generated'
        generated_dir.mkdir(parents=True, exist_ok=True)
        init_file = generated_dir / '__init__.py'
        init_file.touch(exist_ok=True)

        full_name = f'apps.api.generated.{module_name}'
        try:
            return importlib.import_module(full_name)
        except ModuleNotFoundError:
            self._compile_protos(generated_dir)
            repo_root = Path(__file__).resolve().parents[2]
            if str(repo_root) not in sys.path:
                sys.path.append(str(repo_root))
            return importlib.import_module(full_name)

    def _compile_protos(self, generated_dir: Path) -> None:
        from grpc_tools import protoc
        from pkg_resources import resource_filename

        repo_root = Path(__file__).resolve().parents[2]
        proto_dir = repo_root / 'packages' / 'proto'
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
            raise RuntimeError(f'Protobuf compile failed with code={result}')

    @staticmethod
    def now_ts() -> Timestamp:
        ts = Timestamp()
        ts.FromDatetime(datetime.now(timezone.utc))
        return ts
