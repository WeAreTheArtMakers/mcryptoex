import unittest
from unittest.mock import patch

from apps.api.compliance import HTTPException, enforce_optional_compliance
from apps.api.config import get_settings


class ComplianceHooksTests(unittest.TestCase):
    def tearDown(self) -> None:
        get_settings.cache_clear()

    def test_allows_when_disabled(self) -> None:
        with patch.dict(
            'os.environ',
            {
                'COMPLIANCE_ENFORCEMENT_ENABLED': 'false'
            },
            clear=False
        ):
            get_settings.cache_clear()
            enforce_optional_compliance(
                country_code='US',
                wallet_address='0x0000000000000000000000000000000000000001'
            )

    def test_blocks_geo(self) -> None:
        with patch.dict(
            'os.environ',
            {
                'COMPLIANCE_ENFORCEMENT_ENABLED': 'true',
                'COMPLIANCE_BLOCKED_COUNTRIES': 'ir,kp'
            },
            clear=False
        ):
            get_settings.cache_clear()
            with self.assertRaises(HTTPException) as ctx:
                enforce_optional_compliance(country_code='KP')
            self.assertEqual(ctx.exception.status_code, 451)

    def test_blocks_sanctioned_wallet(self) -> None:
        with patch.dict(
            'os.environ',
            {
                'COMPLIANCE_ENFORCEMENT_ENABLED': 'true',
                'COMPLIANCE_SANCTIONS_BLOCKED_WALLETS': '0x1111111111111111111111111111111111111111'
            },
            clear=False
        ):
            get_settings.cache_clear()
            with self.assertRaises(HTTPException) as ctx:
                enforce_optional_compliance(
                    wallet_address='0x1111111111111111111111111111111111111111'
                )
            self.assertEqual(ctx.exception.status_code, 403)
