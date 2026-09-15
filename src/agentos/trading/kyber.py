"""KyberSwap Aggregator provider (opt-in, no API key).

Endpoints (per chain slug ``base`` / ``robinhood``):

* ``GET  aggregator-api.kyberswap.com/{slug}/api/v1/routes`` — best route +
  ``routeSummary`` (stale after ~10 s; re-fetched right before building).
* ``POST aggregator-api.kyberswap.com/{slug}/api/v1/route/build`` — calldata
  for the router, with slippage in basis points.
* ``token-api.kyberswap.com/api/v1/public/tokens`` and
  ``…/tokens/honeypot-fot-info`` — whitelist search and scam checks.

Kyber's edge is geo-fenced: some countries (Vietnam confirmed) get an HTML
403 from Cloudflare. That is reported as ``trading.provider_blocked`` — a
status the UI can explain — never as a crash.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from agentos.trading.chains import NATIVE_ADDRESS, ChainSpec, is_native, normalize_address
from agentos.trading.evm import (
    SEL_APPROVE,
    USER_AGENT,
    EvmClient,
    encode_call,
    pad_address,
    pad_uint,
)
from agentos.trading.providers import (
    PROVIDER_LABELS,
    ProbeResult,
    ProviderBlockedError,
    ProviderError,
    ProviderQuote,
)
from agentos.trading.uniswap import DecisionOrigin

AGGREGATOR_BASE = "https://aggregator-api.kyberswap.com"
TOKEN_API_BASE = "https://token-api.kyberswap.com"
KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
CHAIN_SLUGS: dict[int, str] = {8453: "base", 4663: "robinhood"}
ROUTE_FRESH_S = 8.0
DEFAULT_SLIPPAGE_BPS = 50
MAX_SLIPPAGE_BPS = 2000
BLOCKED_MESSAGE = (
    "KyberSwap is not available from your region (HTTP 403). "
    "Switch the provider to Uniswap or use a VPN."
)


class KyberError(ProviderError):
    pass


@dataclass
class KyberRoute:
    route_summary: dict[str, Any]
    router_address: str
    request_id: str
    fetched_at: float

    @property
    def amount_out_raw(self) -> int:
        return int(str(self.route_summary.get("amountOut") or "0"))


def _f(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def slippage_to_bps(slippage_pct: float | None) -> int:
    if slippage_pct is None:
        return DEFAULT_SLIPPAGE_BPS
    return max(0, min(MAX_SLIPPAGE_BPS, int(round(float(slippage_pct) * 100))))


class KyberClient:
    def __init__(
        self,
        *,
        client_id: str = "agentos",
        http: httpx.AsyncClient | None = None,
        timeout: float = 10.0,
        max_retries: int = 2,
        aggregator_base: str = AGGREGATOR_BASE,
        token_api_base: str = TOKEN_API_BASE,
        sleep: Callable[[float], Any] | None = None,
    ) -> None:
        self.client_id = client_id or "agentos"
        self._own_http = http is None
        self._http = http or httpx.AsyncClient(timeout=timeout)
        self._timeout = timeout
        self._max_retries = max(0, int(max_retries))
        self.aggregator_base = aggregator_base.rstrip("/")
        self.token_api_base = token_api_base.rstrip("/")
        self._sleep = sleep or asyncio.sleep

    async def aclose(self) -> None:
        if self._own_http:
            await self._http.aclose()

    @staticmethod
    def slug(chain: ChainSpec) -> str:
        slug = CHAIN_SLUGS.get(chain.chain_id)
        if slug is None:
            raise KyberError("trading.unsupported_chain", f"KyberSwap does not serve {chain.name}")
        return slug

    @staticmethod
    def to_kyber(address: str) -> str:
        return KYBER_NATIVE if is_native(address) else address

    @staticmethod
    def from_kyber(address: str) -> str:
        if address.lower() == KYBER_NATIVE.lower():
            return NATIVE_ADDRESS
        return normalize_address(address)

    def _headers(self) -> dict[str, str]:
        return {
            "accept": "application/json",
            "user-agent": USER_AGENT,
            "x-client-id": self.client_id,
        }

    async def _request(self, method: str, url: str, **kwargs: Any) -> Any:
        attempt = 0
        while True:
            try:
                response = await self._http.request(
                    method, url, headers=self._headers(), timeout=self._timeout, **kwargs
                )
            except httpx.HTTPError as exc:
                if attempt < self._max_retries:
                    attempt += 1
                    await self._sleep(0.5 * attempt)
                    continue
                raise KyberError(
                    "trading.provider", f"KyberSwap unreachable: {exc}", retryable=True
                ) from exc
            status = response.status_code
            content_type = response.headers.get("content-type", "")
            if status == 403 and "text/html" in content_type.lower():
                raise ProviderBlockedError("kyber", BLOCKED_MESSAGE)
            if status == 429:
                if attempt < self._max_retries:
                    attempt += 1
                    reset = _f(response.headers.get("x-ratelimit-reset-after"))
                    await self._sleep(reset if reset and reset > 0 else 0.5 * (2**attempt))
                    continue
                raise KyberError(
                    "trading.provider", "KyberSwap rate limit exceeded", retryable=True
                )
            return self._parse(response, url)

    @staticmethod
    def _parse(response: httpx.Response, url: str) -> Any:
        status = response.status_code
        try:
            body: Any = response.json()
        except ValueError:
            body = None
        if status == 403:
            raise ProviderBlockedError("kyber", BLOCKED_MESSAGE)
        if status >= 400:
            detail = None
            if isinstance(body, dict):
                detail = body.get("message") or body.get("error") or body.get("details")
            raise KyberError(
                "trading.provider",
                f"KyberSwap {url.rsplit('/', 1)[-1]} failed ({status}): {detail or 'error'}",
                retryable=status >= 500,
            )
        if not isinstance(body, dict):
            raise KyberError("trading.provider", "KyberSwap returned no JSON")
        code = body.get("code")
        if code not in (None, 0, "0"):
            message = str(body.get("message") or "unknown error")
            lowered = message.lower()
            error_code = (
                "trading.no_route"
                if "route" in lowered or "liquidity" in lowered
                else "trading.provider"
            )
            raise KyberError(error_code, f"KyberSwap: {message}", details={"code": code})
        return body

    # ── aggregator ─────────────────────────────────────────────────────

    async def routes(
        self, *, chain: ChainSpec, token_in: str, token_out: str, amount_raw: int, origin: str
    ) -> KyberRoute:
        body = await self._request(
            "GET",
            f"{self.aggregator_base}/{self.slug(chain)}/api/v1/routes",
            params={
                "tokenIn": self.to_kyber(token_in),
                "tokenOut": self.to_kyber(token_out),
                "amountIn": str(amount_raw),
                "gasInclude": "true",
                "origin": origin,
            },
        )
        data = body.get("data") or {}
        summary = data.get("routeSummary")
        router = data.get("routerAddress")
        if not isinstance(summary, dict) or not router:
            raise KyberError("trading.no_route", "KyberSwap found no route for this pair")
        return KyberRoute(
            route_summary=summary,
            router_address=str(router),
            request_id=str(body.get("requestId") or ""),
            fetched_at=time.time(),
        )

    async def build(
        self,
        *,
        chain: ChainSpec,
        route: KyberRoute,
        sender: str,
        recipient: str,
        slippage_bps: int,
        deadline: int,
    ) -> dict[str, Any]:
        body = await self._request(
            "POST",
            f"{self.aggregator_base}/{self.slug(chain)}/api/v1/route/build",
            json={
                "routeSummary": route.route_summary,
                "sender": sender,
                "recipient": recipient,
                "slippageTolerance": int(slippage_bps),
                "deadline": int(deadline),
                "source": "agentos",
                "origin": sender,
                "enableGasEstimation": True,
            },
        )
        data = body.get("data") or {}
        if not data.get("data") or not data.get("routerAddress"):
            raise KyberError("trading.tx_failed", "KyberSwap build returned no calldata")
        return data

    # ── token api ──────────────────────────────────────────────────────

    async def search_tokens(self, *, chain: ChainSpec, query: str) -> list[dict[str, Any]]:
        body = await self._request(
            "GET",
            f"{self.token_api_base}/api/v1/public/tokens",
            params={"chainIds": chain.chain_id, "name": query, "isWhitelisted": "true"},
        )
        tokens = (body.get("data") or {}).get("tokens") or []
        out = []
        for raw in tokens:
            if not isinstance(raw, dict):
                continue
            try:
                address = normalize_address(str(raw.get("address") or ""))
            except ValueError:
                continue
            out.append(
                {
                    "chainId": chain.chain_id,
                    "address": address,
                    "symbol": str(raw.get("symbol") or ""),
                    "name": str(raw.get("name") or ""),
                    "decimals": int(raw.get("decimals") or 18),
                    "logoUrl": raw.get("logoURL") or None,
                    "native": False,
                    "verified": bool(raw.get("isVerified") or raw.get("isWhitelisted")),
                    "marketCap": _f(raw.get("marketCap")),
                }
            )
        return out

    async def honeypot_info(self, *, chain: ChainSpec, address: str) -> dict[str, Any]:
        body = await self._request(
            "GET",
            f"{self.token_api_base}/api/v1/public/tokens/honeypot-fot-info",
            params={"chainId": chain.chain_id, "address": address},
        )
        data = body.get("data") or {}
        return {
            "isHoneypot": bool(data.get("isHoneypot")),
            "isFOT": bool(data.get("isFOT")),
            "tax": _f(data.get("tax")),
        }

    async def probe(self, *, chain: ChainSpec) -> ProbeResult:
        started = time.monotonic()
        usdc = chain.usdc or "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        try:
            await self.routes(
                chain=chain,
                token_in=NATIVE_ADDRESS,
                token_out=usdc,
                amount_raw=10**15,
                origin="0x0000000000000000000000000000000000000001",
            )
        except ProviderBlockedError as exc:
            return ProbeResult(ok=False, latency_ms=None, error=str(exc), blocked=True)
        except ProviderError as exc:
            latency = (time.monotonic() - started) * 1000
            if exc.code == "trading.no_route":
                return ProbeResult(ok=True, latency_ms=latency, error=None)
            return ProbeResult(ok=False, latency_ms=latency, error=str(exc))
        return ProbeResult(ok=True, latency_ms=(time.monotonic() - started) * 1000, error=None)


class KyberProvider:
    id = "kyber"
    label = PROVIDER_LABELS["kyber"]
    needs_api_key = False

    def __init__(self, client: KyberClient) -> None:
        self.client = client

    async def probe(self, *, chain: ChainSpec) -> ProbeResult:
        return await self.client.probe(chain=chain)

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
        warnings: list[str] = []
        out_addr = NATIVE_ADDRESS if is_native(token_out) else normalize_address(token_out)
        if out_addr != NATIVE_ADDRESS:
            try:
                info = await self.client.honeypot_info(chain=chain, address=out_addr)
            except ProviderBlockedError:
                raise
            except ProviderError:
                info = {}
            if info.get("isHoneypot"):
                raise KyberError(
                    "trading.honeypot", "KyberSwap flags the output token as a honeypot; refusing"
                )
            if info.get("isFOT"):
                tax = info.get("tax")
                warnings.append(
                    "Output token charges a transfer tax"
                    + (f" (~{tax:.2f}%)" if isinstance(tax, float) else "")
                    + "; received amount may be lower than quoted."
                )
        route = await self.client.routes(
            chain=chain,
            token_in=token_in,
            token_out=token_out,
            amount_raw=amount_raw,
            origin=swapper,
        )
        summary = route.route_summary
        amount_out = route.amount_out_raw
        slippage = float(slippage_pct) if slippage_pct is not None else DEFAULT_SLIPPAGE_BPS / 100
        min_out = int(amount_out * (1 - slippage / 100.0))
        in_usd = _f(summary.get("amountInUsd"))
        out_usd = _f(summary.get("amountOutUsd"))
        impact = None
        if in_usd and out_usd is not None and in_usd > 0:
            impact = max(0.0, (1 - out_usd / in_usd) * 100.0)
        gas_usd = _f(summary.get("gasUsd"))
        l1 = _f(summary.get("l1FeeUsd"))
        if gas_usd is not None and l1:
            gas_usd += l1
        return ProviderQuote(
            provider=self.id,
            chain_id=chain.chain_id,
            swapper=swapper,
            token_in=NATIVE_ADDRESS if is_native(token_in) else normalize_address(token_in),
            token_out=out_addr,
            amount_in_raw=int(str(summary.get("amountIn") or amount_raw)),
            amount_out_raw=amount_out,
            min_out_raw=min_out,
            slippage_pct=slippage,
            price_impact_pct=impact,
            gas_usd=gas_usd,
            quote_id=str(summary.get("routeID") or route.request_id or "") or None,
            routing="KYBER",
            fetched_at=route.fetched_at,
            fresh_for_s=ROUTE_FRESH_S,
            raw=route,
            warnings=warnings,
        )

    async def approval_tx(
        self, quote: ProviderQuote, *, evm: EvmClient, decision_origin: DecisionOrigin
    ) -> dict[str, Any] | None:
        if is_native(quote.token_in):
            return None
        route: KyberRoute = quote.raw
        spender = route.router_address
        allowance = await evm.erc20_allowance(quote.token_in, quote.swapper, spender)
        if allowance >= quote.amount_in_raw:
            return None
        return {
            "to": quote.token_in,
            "from": quote.swapper,
            "data": encode_call(SEL_APPROVE, pad_address(spender), pad_uint(quote.amount_in_raw)),
            "value": "0",
            "chainId": quote.chain_id,
        }

    def trusted_spenders(self, chain: ChainSpec, quote: ProviderQuote) -> frozenset[str]:
        route: KyberRoute = quote.raw
        return frozenset({str(route.router_address).lower()})

    async def build(
        self,
        quote: ProviderQuote,
        *,
        deadline: int,
        sign_permit: Callable[[dict[str, Any]], str] | None,
        decision_origin: DecisionOrigin,
    ) -> dict[str, Any]:
        route: KyberRoute = quote.raw
        chain = _chain_for(quote.chain_id)
        if time.time() - quote.fetched_at > ROUTE_FRESH_S:
            route = await self.client.routes(
                chain=chain,
                token_in=quote.token_in,
                token_out=quote.token_out,
                amount_raw=quote.amount_in_raw,
                origin=quote.swapper,
            )
            quote.raw = route
            quote.amount_out_raw = route.amount_out_raw
            quote.fetched_at = route.fetched_at
        data = await self.client.build(
            chain=chain,
            route=route,
            sender=quote.swapper,
            recipient=quote.swapper,
            slippage_bps=slippage_to_bps(quote.slippage_pct),
            deadline=deadline,
        )
        built_out = data.get("amountOut")
        if built_out:
            # The build's ``amountOut`` is the route's expected output; the
            # floor the router enforces is that minus the slippage we asked
            # for. Reporting the expected figure as ``minOut`` overstated it.
            quote.amount_out_raw = int(str(built_out))
            bps = slippage_to_bps(quote.slippage_pct)
            quote.min_out_raw = quote.amount_out_raw * (10_000 - bps) // 10_000
        change = data.get("outputChange") or {}
        if isinstance(change, dict) and change.get("level") not in (None, 0, "0"):
            quote.warnings.append(
                f"Route output changed by {change.get('percent')}% since the quote."
            )
        gas = int(str(data.get("gas") or "0")) if data.get("gas") else 0
        tx: dict[str, Any] = {
            "to": str(data["routerAddress"]),
            "from": quote.swapper,
            "data": str(data["data"]),
            "value": str(data.get("transactionValue") or "0"),
            "chainId": quote.chain_id,
        }
        if gas > 0:
            tx["gasLimit"] = str(int(gas * 1.2))
        return tx


def _chain_for(chain_id: int) -> ChainSpec:
    from agentos.trading.chains import chain_by_id

    return chain_by_id(chain_id)


def blocked_payload() -> dict[str, Any]:
    """The JSON shape the RPC layer attaches to a geo-block error."""
    return {"provider": "kyber", "blocked": True, "hint": BLOCKED_MESSAGE}


__all__ = [
    "KYBER_NATIVE",
    "KyberClient",
    "KyberError",
    "KyberProvider",
    "KyberRoute",
    "blocked_payload",
    "slippage_to_bps",
]
