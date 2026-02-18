import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from apps.api.chain_registry import load_chain_registry, risk_assumptions_payload, tokens_payload
from apps.api.config import get_settings


class ChainRegistryTests(unittest.TestCase):
    def tearDown(self) -> None:
        get_settings.cache_clear()
        load_chain_registry.cache_clear()

    def test_tokens_and_risk_from_registry_file(self) -> None:
        payload = {
            'version': 1,
            'generated_at': '2026-02-18T00:00:00Z',
            'chains': [
                {
                    'chain_key': 'bnb-testnet',
                    'chain_id': 97,
                    'name': 'BNB Chain Testnet',
                    'network': 'bscTestnet',
                    'tokens': [
                        {'symbol': 'mUSD', 'name': 'Musical USD', 'address': '0xabc', 'decimals': 18}
                    ],
                    'trust_assumptions': [
                        {
                            'endpoint': 'wrapped-btc-evm',
                            'asset_symbol': 'wBTC',
                            'risk_level': 'high',
                            'statement': 'Bridge custody required'
                        }
                    ]
                }
            ]
        }

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'chain-registry.generated.json'
            path.write_text(json.dumps(payload), encoding='utf-8')

            with patch.dict('os.environ', {'CHAIN_REGISTRY_PATH': str(path)}, clear=False):
                get_settings.cache_clear()
                load_chain_registry.cache_clear()

                tokens = tokens_payload()
                risk = risk_assumptions_payload(97)

        self.assertIn('97', tokens['chains'])
        self.assertEqual(tokens['networks'][0]['chain_key'], 'bnb-testnet')
        self.assertEqual(risk['assumptions'][0]['endpoint'], 'wrapped-btc-evm')
