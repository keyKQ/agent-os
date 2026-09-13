"""Swap providers: one protocol, two implementations.

The service only ever talks to a :class:`SwapProvider`: quote, approval
transaction (if any), swap transaction. Uniswap's Trading API is the
default; KyberSwap's aggregator is the opt-in alternative (no API key). Each
provider normalises its own quirks — native-token sentinel, quote freshness,
slippage units — so the order pipeline stays provider-agnostic.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from agentos.trading.chains import NATIVE_ADDRESS, ChainSpec, is_native
from agentos.trading.evm import EvmClient
from agentos.trading.uniswap import (
    DecisionOrigin,
    Quote,
    UniswapAuthError,
    UniswapClient,
    UniswapError,
)

ProviderId = Literal["uniswap", "kyber"]
PROVIDER_IDS: tuple[str, ...] = ("uniswap", "kyber")
PROVIDER_LABELS: dict[str, str] = {"uniswap": "Uniswap", "kyber": "KyberSwap"}


class ProviderError(RuntimeError):
    """A provider failure with a stable error code for the RPC layer."""

    def __init__(
        self, code: str, message: str, *, retryable: bool = False, details: Any = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.details = details


class ProviderBlockedError(ProviderError):
    """The provider refuses requests from this network location (geo-block)."""

    def __init__(self, provider: str, message: str) -> None:
        super().__init__("trading.provider_blocked", message)
        self.provider = provider


@dataclass
class ProbeResult:
    ok: bool
    latency_ms: float | None
    error: str | None
    blocked: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "latencyMs": round(self.latency_ms, 1) if self.latency_ms is not None else None,
            "error": self.error,
            "blocked": self.blocked,
        }


@dataclass
class ProviderQuote:
    """A provider-neutral quote. ``raw`` is the provider's own object."""

    provider: str
    chain_id: int
    swapper: str
    token_in: str  # lowercase; NATIVE_ADDRESS for the gas token
    token_out: str
    amount_in_raw: int
    amount_out_raw: int
    min_out_raw: int
    slippage_pct: float | None
    price_impact_pct: float | None
    gas_usd: float | None
    quote_id: str | None
    routing: str
    fetched_at: float
    fresh_for_s: float
    raw: Any
    warnings: list[str] = field(default_factory=list)

    @property
    def age_s(self) -> float:
        return max(0.0, time.time() - self.fetched_at)

    @property
    def fresh(self) -> bool:
        return self.age_s < self.fresh_for_s


class SwapProvider(Protocol):
    id: str
    label: str
    needs_api_key: bool

    async def probe(self, *, chain: ChainSpec) -> ProbeResult: ...

    async def quote(
        self,
        *,
        chain: ChainSpec,
        swapper: str,
        token_in: str,
        token_out: str,
        amount_raw: int,
        slippage_pct: float | None,
        decision_origin: DecisionOrigin,
    ) -> ProviderQuote: ...

    async def approval_tx(
        self, quote: ProviderQuote, *, evm: EvmClient, decision_origin: DecisionOrigin
    ) -> dict[str, Any] | None: ...

    async def build(
        self,
        quote: ProviderQuote,
        *,
        deadline: int,
        sign_permit: Callable[[dict[str, Any]], str] | None,
        decision_origin: DecisionOrigin,
    ) -> dict[str, Any]: ...


# ── Uniswap ────────────────────────────────────────────────────────────────


class UniswapProvider:
    id = "uniswap"
    label = PROVIDER_LABELS["uniswap"]
    needs_api_key = True

    def __init__(self, client: UniswapClient) -> None:
        self.client = client

    @staticmethod
    def _addr(address: str) -> str:
        return NATIVE_ADDRESS if is_native(address) else address

    async def probe(self, *, chain: ChainSpec) -> ProbeResult:
        try:
            ok, latency, error = await self.client.probe(chain_id=chain.chain_id)
        except UniswapAuthError as exc:
            return ProbeResult(ok=False, latency_ms=None, error=str(exc))
        return ProbeResult(ok=ok, latency_ms=latency, error=error)

    async def quote(
        self,
        *,
        chain: ChainSpec,
        swapper: str,
        token_in: str,
        token_out: str,
        amount_raw: int,
        slippage_pct: float | None,
        decision_origin: DecisionOrigin,
    ) -> ProviderQuote:
        try:
            quote = await self.client.quote(
                chain_id=chain.chain_id,
                swapper=swapper,
                token_in=self._addr(token_in),
                token_out=self._addr(token_out),
                amount_raw=amount_raw,
                slippage_pct=slippage_pct,
                decision_origin=decision_origin,
            )
        except UniswapError as exc:
            raise ProviderError(
                exc.code, str(exc), retryable=exc.retryable, details={"errorCode": exc.error_code}
            ) from exc
        return ProviderQuote(
            provider=self.id,
            chain_id=chain.chain_id,
            swapper=swapper,
            token_in=self._addr(token_in).lower(),
            token_out=self._addr(token_out).lower(),
            amount_in_raw=quote.amount_in_raw,
            amount_out_raw=quote.amount_out_raw,
            min_out_raw=quote.min_out_raw,
            slippage_pct=quote.slippage_pct,
            price_impact_pct=quote.price_impact_pct,
            gas_usd=quote.gas_fee_usd,
            quote_id=quote.quote_id or quote.request_id,
            routing=quote.routing,
            fetched_at=quote.fetched_at,
            fresh_for_s=30.0,
            raw=quote,
        )

    async def approval_tx(
        self, quote: ProviderQuote, *, evm: EvmClient, decision_origin: DecisionOrigin
    ) -> dict[str, Any] | None:
        if is_native(quote.token_in):
            return None
        try:
            return await self.client.check_approval(
                chain_id=quote.chain_id,
                wallet=quote.swapper,
                token=quote.token_in,
                amount_raw=quote.amount_in_raw,
                decision_origin=decision_origin,
            )
        except UniswapError as exc:
            raise ProviderError(exc.code, str(exc), retryable=exc.retryable) from exc

    async def build(
        self,
        quote: ProviderQuote,
        *,
        deadline: int,
        sign_permit: Callable[[dict[str, Any]], str] | None,
        decision_origin: DecisionOrigin,
    ) -> dict[str, Any]:
        raw: Quote = quote.raw
        signature = None
        if raw.permit_data is not None:
            if sign_permit is None:
                raise ProviderError("trading.tx_failed", "quote needs a permit signature")
            signature = sign_permit(raw.permit_data)
        try:
            return await self.client.swap(
                raw, signature=signature, deadline=deadline, decision_origin=decision_origin
            )
        except UniswapError as exc:
            raise ProviderError(exc.code, str(exc), retryable=exc.retryable) from exc


def provider_label(provider_id: str) -> str:
    return PROVIDER_LABELS.get(provider_id, provider_id)
