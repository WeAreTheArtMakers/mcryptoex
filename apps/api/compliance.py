from __future__ import annotations

try:
    from fastapi import HTTPException
except ModuleNotFoundError:  # pragma: no cover - local fallback for lightweight checks
    class HTTPException(Exception):
        def __init__(self, status_code: int, detail: str) -> None:
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

from .config import get_settings


def _csv_set(raw: str) -> set[str]:
    return {item.strip().lower() for item in raw.split(',') if item.strip()}


def enforce_optional_compliance(
    *,
    country_code: str | None = None,
    wallet_address: str | None = None
) -> None:
    settings = get_settings()
    if not settings.compliance_enforcement_enabled:
        return

    blocked_countries = _csv_set(settings.compliance_blocked_countries)
    blocked_wallets = _csv_set(settings.compliance_sanctions_blocked_wallets)

    if country_code and country_code.lower() in blocked_countries:
        raise HTTPException(
            status_code=451,
            detail='Request blocked by operator geofencing policy'
        )

    if wallet_address and wallet_address.lower() in blocked_wallets:
        raise HTTPException(
            status_code=403,
            detail='Wallet blocked by operator sanctions policy'
        )
