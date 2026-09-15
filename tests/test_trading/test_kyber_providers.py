"""KyberSwap client/provider, provider selection, probe per provider, config."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from agentos.gateway.config import GatewayConfig, TradingConfig
from agentos.gateway.rpc import RpcContext, get_dispatcher
from agentos.trading import chains
from agentos.trading.chains import BASE, NATIVE_ADDRESS, ROBINHOOD
from agentos.trading.evm import EvmClient
from agentos.trading.kyber import KYBER_NATIVE, KyberClient, KyberProvider, slippage_to_bps
from agentos.trading.providers import (
    PROVIDER_IDS,
    ProviderBlockedError,
    ProviderError,
    UniswapProvider,
)
from agentos.trading.service import TradingError, TradingService
from agentos.trading.uniswap import UniswapClient
from tests.test_trading.fakes import ROUTER, USDC, WALLET, WETH, FakeChain, FakeUniswap
from tests.test_trading.test_service import _wire_swap_effects

KYBER_ROUTER = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5"
HONEYPOT = "0xbad0000000000000000000000000000000000bad"


class FakeKyber:
    """aggregator-api + token-api doubles with switchable failure modes."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.blocked = False
        self.rate_limit_times = 0
        self.route_error: str | None = None
        self.amount_out = 500_000_000_000_000
        self.build_amount_out: int | None = None
        self.output_change_level = 0
        self.honeypots: set[str] = set()
        self.fot: set[str] = set()
        self.tokens: list[dict[str, Any]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.blocked:
            return httpx.Response(
                403,
                headers={"content-type": "text/html; charset=utf-8"},
                text="<html><body>Access from your country is currently restricted</body></html>",
            )
        if self.rate_limit_times > 0:
            self.rate_limit_times -= 1
            return httpx.Response(429, headers={"x-ratelimit-reset-after": "0.01"}, json={})
        host, path = request.url.host, request.url.path
        if host == "aggregator-api.kyberswap.com":
            _, slug, _, _, endpoint = path.split("/", 4)
            if endpoint == "routes":
                if self.route_error:
                    return httpx.Response(200, json={"code": 4008, "message": self.route_error})
                q = dict(request.url.params)
                amount_in = q["amountIn"]
                summary = {
                    "tokenIn": q["tokenIn"],
                    "amountIn": amount_in,
                    "amountInUsd": "10",
                    "tokenOut": q["tokenOut"],
                    "amountOut": str(self.amount_out),
                    "amountOutUsd": "9.9",
                    "gas": "210000",
                    "gasPrice": "100000000",
                    "gasUsd": "0.04",
                    "l1FeeUsd": "0.01",
                    "route": [],
                    "routeID": "route-1",
                    "checksum": "abc",
                    "timestamp": 1_700_000_000,
                    "extraFee": {},
                }
                return httpx.Response(
                    200,
                    json={
                        "code": 0,
                        "message": "successfully",
                        "data": {"routeSummary": summary, "routerAddress": KYBER_ROUTER},
                        "requestId": "req-kyber",
                    },
                )
            if endpoint == "route/build":
                body = json.loads(request.content)
                # Kyber's build returns the route's expected output (already
                # reflecting any outputChange), never a slippage-adjusted floor.
                out = (
                    self.build_amount_out
                    or int(body["routeSummary"]["amountOut"])
                    * (985 if self.output_change_level else 1000)
                    // 1000
                )
                return httpx.Response(
                    200,
                    json={
                        "code": 0,
                        "data": {
                            "amountIn": body["routeSummary"]["amountIn"],
                            "amountInUsd": "10",
                            "amountOut": str(out),
                            "amountOutUsd": "9.9",
                            "gas": "220000",
                            "gasUsd": "0.05",
                            "outputChange": {
                                "amount": "0",
                                "percent": -1.5 if self.output_change_level else 0,
                                "level": self.output_change_level,
                            },
                            "data": "0xe21fd0e9" + "22" * 32,
                            "routerAddress": KYBER_ROUTER,
                            "transactionValue": "0"
                            if body["routeSummary"]["tokenIn"].lower() != KYBER_NATIVE.lower()
                            else body["routeSummary"]["amountIn"],
                        },
                    },
                )
        if host == "token-api.kyberswap.com":
            if path.endswith("/honeypot-fot-info"):
                address = dict(request.url.params)["address"].lower()
                return httpx.Response(
                    200,
                    json={
                        "code": 0,
                        "data": {
                            "isHoneypot": address in self.honeypots,
                            "isFOT": address in self.fot,
                            "tax": 5.0 if address in self.fot else 0,
                        },
                    },
                )
            if path.endswith("/public/tokens"):
                return httpx.Response(200, json={"code": 0, "data": {"tokens": self.tokens}})
        return httpx.Response(404, json={"code": 404})


@pytest.fixture
def kyber() -> FakeKyber:
    return FakeKyber()


@pytest.fixture
async def kyber_client(kyber: FakeKyber):
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    async with httpx.AsyncClient(transport=httpx.MockTransport(kyber.handle)) as http:
        client = KyberClient(client_id="agentos-test", http=http, sleep=fake_sleep)
        client.sleeps = sleeps  # type: ignore[attr-defined]
        yield client


class TestKyberClient:
    async def test_routes_headers_and_native_sentinel(
        self, kyber: FakeKyber, kyber_client: KyberClient
    ) -> None:
        route = await kyber_client.routes(
            chain=BASE, token_in=NATIVE_ADDRESS, token_out=USDC, amount_raw=10**15, origin=WALLET
        )
        request = kyber.requests[-1]
        assert request.url.path == "/base/api/v1/routes"
        assert request.headers["x-client-id"] == "agentos-test"
        assert request.headers["user-agent"].startswith("agentos-trading/")
        params = dict(request.url.params)
        assert params["tokenIn"] == KYBER_NATIVE and params["tokenOut"] == USDC
        assert params["gasInclude"] == "true" and params["origin"] == WALLET
        assert route.router_address == KYBER_ROUTER and route.amount_out_raw == kyber.amount_out
        assert KyberClient.slug(ROBINHOOD) == "robinhood"
        assert KyberClient.from_kyber(KYBER_NATIVE) == NATIVE_ADDRESS

    async def test_build_body(self, kyber: FakeKyber, kyber_client: KyberClient) -> None:
        route = await kyber_client.routes(
            chain=BASE, token_in=USDC, token_out=WETH, amount_raw=10 * 10**6, origin=WALLET
        )
        data = await kyber_client.build(
            chain=BASE, route=route, sender=WALLET, recipient=WALLET, slippage_bps=75, deadline=123
        )
        body = json.loads(kyber.requests[-1].content)
        assert body["routeSummary"] == route.route_summary
        assert body["slippageTolerance"] == 75 and body["deadline"] == 123
        assert (
            body["source"] == "agentos"
            and body["origin"] == WALLET
            and body["enableGasEstimation"] is True
        )
        assert data["routerAddress"] == KYBER_ROUTER and data["data"].startswith("0x")

    async def test_geo_block_is_a_coded_error(
        self, kyber: FakeKyber, kyber_client: KyberClient
    ) -> None:
        kyber.blocked = True
        with pytest.raises(ProviderBlockedError) as info:
            await kyber_client.routes(
                chain=BASE, token_in=USDC, token_out=WETH, amount_raw=1, origin=WALLET
            )
        assert info.value.code == "trading.provider_blocked" and "region" in str(info.value)
        probe = await kyber_client.probe(chain=BASE)
        assert probe.ok is False and probe.blocked is True and probe.error

    async def test_429_backoff_honours_reset_header(
        self, kyber: FakeKyber, kyber_client: KyberClient
    ) -> None:
        kyber.rate_limit_times = 2
        await kyber_client.routes(
            chain=BASE, token_in=USDC, token_out=WETH, amount_raw=1, origin=WALLET
        )
        assert kyber_client.sleeps == [0.01, 0.01]  # type: ignore[attr-defined]
        kyber.rate_limit_times = 3
        with pytest.raises(ProviderError, match="rate limit"):
            await kyber_client.routes(
                chain=BASE, token_in=USDC, token_out=WETH, amount_raw=1, origin=WALLET
            )

    async def test_api_error_codes(self, kyber: FakeKyber, kyber_client: KyberClient) -> None:
        kyber.route_error = "no route found"
        with pytest.raises(ProviderError) as info:
            await kyber_client.routes(
                chain=BASE, token_in=USDC, token_out=WETH, amount_raw=1, origin=WALLET
            )
        assert info.value.code == "trading.no_route"
        assert (
            await kyber_client.probe(chain=BASE)
        ).ok is True  # no-route still proves reachability

    async def test_token_search_and_honeypot(
        self, kyber: FakeKyber, kyber_client: KyberClient
    ) -> None:
        kyber.tokens = [
            {
                "address": USDC,
                "symbol": "USDC",
                "name": "USD Coin",
                "decimals": 6,
                "isVerified": True,
                "isWhitelisted": True,
                "marketCap": "1e9",
                "logoURL": "https://l",
            }
        ]
        rows = await kyber_client.search_tokens(chain=BASE, query="usd")
        assert (
            rows[0]["symbol"] == "USDC"
            and rows[0]["verified"] is True
            and rows[0]["logoUrl"] == "https://l"
        )
        kyber.honeypots.add(HONEYPOT)
        info = await kyber_client.honeypot_info(chain=BASE, address=HONEYPOT)
        assert info == {"isHoneypot": True, "isFOT": False, "tax": 0.0}

    def test_slippage_bps(self) -> None:
        assert slippage_to_bps(None) == 50
        assert slippage_to_bps(0.5) == 50 and slippage_to_bps(1.25) == 125
        assert slippage_to_bps(99) == 2000 and slippage_to_bps(-1) == 0


class TestKyberProvider:
    async def test_quote_shape_and_warnings(
        self, kyber: FakeKyber, kyber_client: KyberClient
    ) -> None:
        provider = KyberProvider(kyber_client)
        kyber.fot.add(WETH)
        quote = await provider.quote(
            chain=BASE,
            swapper=WALLET,
            token_in=USDC,
            token_out=WETH,
            amount_raw=10 * 10**6,
            slippage_pct=1.0,
            decision_origin="human_mediated",
        )
        assert quote.provider == "kyber" and quote.routing == "KYBER"
        assert quote.amount_out_raw == kyber.amount_out and quote.min_out_raw == int(
            kyber.amount_out * 0.99
        )
        assert quote.price_impact_pct == pytest.approx(1.0)
        assert quote.gas_usd == pytest.approx(0.05)
        assert quote.warnings and "transfer tax" in quote.warnings[0]
        assert quote.fresh

    async def test_honeypot_refused(self, kyber: FakeKyber, kyber_client: KyberClient) -> None:
        kyber.honeypots.add(HONEYPOT)
        with pytest.raises(ProviderError) as info:
            await KyberProvider(kyber_client).quote(
                chain=BASE,
                swapper=WALLET,
                token_in=USDC,
                token_out=HONEYPOT,
                amount_raw=1,
                slippage_pct=None,
                decision_origin="autonomous",
            )
        assert info.value.code == "trading.honeypot"

    async def test_approval_uses_router_from_response(
        self, kyber: FakeKyber, kyber_client: KyberClient
    ) -> None:
        chain = FakeChain(chain_id=8453)
        chain.set_erc20(USDC, WALLET, 100 * 10**6)
        async with httpx.AsyncClient(transport=httpx.MockTransport(chain.handle)) as http:
            evm = EvmClient("https://mainnet.base.org", http=http)
            provider = KyberProvider(kyber_client)
            quote = await provider.quote(
                chain=BASE,
                swapper=WALLET,
                token_in=USDC,
                token_out=WETH,
                amount_raw=10 * 10**6,
                slippage_pct=None,
                decision_origin="human_mediated",
            )
            tx = await provider.approval_tx(quote, evm=evm, decision_origin="human_mediated")
            assert tx is not None and tx["to"] == USDC
            assert tx["data"].startswith("0x095ea7b3") and KYBER_ROUTER[2:] in tx["data"]
            native_quote = await provider.quote(
                chain=BASE,
                swapper=WALLET,
                token_in=NATIVE_ADDRESS,
                token_out=USDC,
                amount_raw=10**15,
                slippage_pct=None,
                decision_origin="human_mediated",
            )
            assert (
                await provider.approval_tx(native_quote, evm=evm, decision_origin="human_mediated")
                is None
            )

    async def test_build_produces_router_tx(
        self, kyber: FakeKyber, kyber_client: KyberClient
    ) -> None:
        provider = KyberProvider(kyber_client)
        quote = await provider.quote(
            chain=BASE,
            swapper=WALLET,
            token_in=NATIVE_ADDRESS,
            token_out=USDC,
            amount_raw=10**15,
            slippage_pct=0.5,
            decision_origin="human_mediated",
        )
        kyber.output_change_level = 1
        tx = await provider.build(
            quote, deadline=999, sign_permit=None, decision_origin="human_mediated"
        )
        assert tx["to"] == KYBER_ROUTER and tx["value"] == str(10**15) and tx["from"] == WALLET
        assert tx["gasLimit"] == str(int(220000 * 1.2))
        # The floor is the built output minus the slippage asked for (0.5%),
        # never the built output itself.
        built_out = kyber.amount_out * 985 // 1000
        assert quote.amount_out_raw == built_out
        assert quote.min_out_raw == built_out * 995 // 1000
        assert quote.min_out_raw < quote.amount_out_raw
        assert any("changed" in w for w in quote.warnings)
        # A stale route is re-fetched before building.
        quote.fetched_at -= 60
        routes_before = sum(1 for r in kyber.requests if r.url.path.endswith("/routes"))
        await provider.build(
            quote, deadline=999, sign_permit=None, decision_origin="human_mediated"
        )
        assert sum(1 for r in kyber.requests if r.url.path.endswith("/routes")) == routes_before + 1


class TestUniswapProvider:
    async def test_wraps_client(self) -> None:
        fake = FakeUniswap()
        async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handle)) as http:
            provider = UniswapProvider(UniswapClient("test-key", http=http))
            quote = await provider.quote(
                chain=BASE,
                swapper=WALLET,
                token_in="ETH",
                token_out=USDC,
                amount_raw=10**15,
                slippage_pct=None,
                decision_origin="autonomous",
            )
            assert quote.provider == "uniswap" and quote.token_in == NATIVE_ADDRESS
            assert quote.routing == "CLASSIC" and quote.fresh_for_s == 30.0
            tx = await provider.build(
                quote, deadline=1, sign_permit=None, decision_origin="autonomous"
            )
            assert tx["to"].lower() == ROUTER
            probe = await provider.probe(chain=BASE)
            assert probe.ok and probe.blocked is False


class TestConfigAndRpcUrls:
    def test_provider_default_and_validation(self) -> None:
        assert TradingConfig().provider == "uniswap"
        assert TradingConfig().kyber_client_id == "agentos"
        assert TradingConfig(provider="kyber").provider == "kyber"
        with pytest.raises(ValueError):
            TradingConfig(provider="1inch")
        assert PROVIDER_IDS == ("uniswap", "kyber")

    def test_rpc_env_fallback(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("RPC_BASE_URL", "https://drpc/base")
        monkeypatch.setenv("RPC_ROBINHOOD_URL", "https://drpc/hood")
        assert chains.rpc_url_for(BASE, {}) == "https://drpc/base"
        assert chains.rpc_url_for(ROBINHOOD, None) == "https://drpc/hood"
        assert chains.rpc_url_for(BASE, {"8453": "https://cfg"}) == "https://cfg"
        monkeypatch.delenv("RPC_BASE_URL")
        assert chains.rpc_url_for(BASE, {}) == BASE.rpc_url


@pytest.fixture
def kyber_service(
    service: TradingService, kyber: FakeKyber, transport: httpx.MockTransport
) -> TradingService:
    """The shared service fixture, with Kyber hosts routed to the fake."""
    inner = transport.handler

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host.endswith("kyberswap.com"):
            return kyber.handle(request)
        return inner(request)  # type: ignore[no-any-return]

    async def fake_sleep(_: float) -> None:
        return None

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service._http = http
    service._evm.clear()
    service.prices._http = http
    service._uniswap = None
    service._kyber_factory = lambda cid: KyberClient(client_id=cid, http=http, sleep=fake_sleep)
    service._uniswap_factory = lambda key: UniswapClient(key, http=http)
    return service


class TestProviderSelection:
    async def test_status_lists_providers_and_default(self, kyber_service: TradingService) -> None:
        status = await kyber_service.status(check_rpc=True)
        assert status["provider"] == "uniswap"
        by_id = {p["id"]: p for p in status["providers"]}
        assert by_id["uniswap"]["needsKey"] is True and by_id["uniswap"]["active"] is True
        assert (
            by_id["kyber"]["needsKey"] is False
            and by_id["kyber"]["healthy"] is True
            and by_id["kyber"]["blocked"] is False
        )

    async def test_probe_per_provider_and_blocked(
        self, kyber_service: TradingService, kyber: FakeKyber
    ) -> None:
        assert (await kyber_service.probe())["provider"] == "uniswap"
        result = await kyber_service.probe(provider_id="kyber")
        assert result["ok"] is True and result["blocked"] is False
        kyber.blocked = True
        blocked = await kyber_service.probe(provider_id="kyber")
        assert blocked == {
            "provider": "kyber",
            "ok": False,
            "latencyMs": None,
            "error": blocked["error"],
            "blocked": True,
        }
        assert "region" in blocked["error"]
        with pytest.raises(TradingError):
            await kyber_service.probe(provider_id="1inch")

    async def test_config_change_switches_provider_without_restart(
        self, kyber_service: TradingService, kyber: FakeKyber, base_chain: FakeChain
    ) -> None:
        service = kyber_service
        service.vault.setup("correct horse battery", "auto")
        wallet = (await service.create_wallet("Main"))["address"]
        base_chain.set_native(wallet, 10**18)
        base_chain.set_erc20(USDC, wallet, 1000 * 10**6)
        quote = await service.quote(
            chain=BASE, wallet=None, token_in="USDC", token_out="WETH", amount_in="10"
        )
        assert quote["provider"] == "uniswap" and quote["providerLabel"] == "Uniswap"
        service.config.provider = "kyber"
        quote = await service.quote(
            chain=BASE, wallet=None, token_in="USDC", token_out="WETH", amount_in="10"
        )
        assert (
            quote["provider"] == "kyber"
            and quote["providerLabel"] == "KyberSwap"
            and quote["warnings"] == []
        )
        assert any(r.url.host == "aggregator-api.kyberswap.com" for r in kyber.requests)

    async def test_kyber_swap_end_to_end(
        self, kyber_service: TradingService, kyber: FakeKyber, base_chain: FakeChain
    ) -> None:
        service = kyber_service
        service.config.provider = "kyber"
        service.vault.setup("correct horse battery", "auto")
        wallet = (await service.create_wallet("Main"))["address"]
        base_chain.set_native(wallet, 10**18)
        base_chain.set_erc20(USDC, wallet, 1000 * 10**6)
        _wire_swap_effects(base_chain, wallet)
        # The fake's swap effect keys on the Uniswap router; point it at Kyber's.
        original = base_chain.on_send

        def on_send(raw: str) -> str:
            return original(raw.replace(KYBER_ROUTER[2:], ROUTER[2:]))  # type: ignore[misc]

        base_chain.on_send = on_send
        orders = await service.swap(
            chain=BASE,
            wallets=None,
            token_in="USDC",
            token_out="WETH",
            amount_in="10",
            amount_pct=None,
            slippage_pct=0.5,
            initiator="manual",
            session_key=None,
            note=None,
            wait=True,
        )
        order = orders[0]
        assert order["status"] == "confirmed", order
        assert order["provider"] == "kyber" and order["providerLabel"] == "KyberSwap"
        assert order["approvalTxHash"]  # allowance was zero → approve(router) went first
        paths = [r.url.path for r in kyber.requests]
        assert any(p.endswith("/routes") for p in paths) and any(
            p.endswith("/route/build") for p in paths
        )

    async def test_blocked_kyber_fails_order_cleanly(
        self, kyber_service: TradingService, kyber: FakeKyber, base_chain: FakeChain
    ) -> None:
        service = kyber_service
        service.config.provider = "kyber"
        service.vault.setup("correct horse battery", "auto")
        wallet = (await service.create_wallet("Main"))["address"]
        base_chain.set_native(wallet, 10**18)
        base_chain.set_erc20(USDC, wallet, 1000 * 10**6)
        kyber.blocked = True
        with pytest.raises(TradingError) as info:
            await service.quote(
                chain=BASE, wallet=None, token_in="USDC", token_out="WETH", amount_in="10"
            )
        assert info.value.code == "trading.provider_blocked" and info.value.details == {
            "provider": "kyber",
            "blocked": True,
        }
        orders = await service.swap(
            chain=BASE,
            wallets=None,
            token_in="USDC",
            token_out="WETH",
            amount_in="10",
            amount_pct=None,
            slippage_pct=None,
            initiator="agent",
            session_key=None,
            note=None,
        )
        assert orders[0]["status"] == "failed" and "trading.provider_blocked" in orders[0]["reason"]


class TestSetProviderRpc:
    async def test_set_provider_persists_and_applies_hot(
        self, kyber_service: TradingService, tmp_path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        config = GatewayConfig()
        config.trading = kyber_service.config
        config.config_path = str(tmp_path / "config.toml")
        monkeypatch.setenv("AGENTOS_GATEWAY_CONFIG_PATH", config.config_path)
        ctx = RpcContext(conn_id="t", config=config)
        res = await get_dispatcher().dispatch(
            "r1", "trading.setProvider", {"provider": "kyber"}, ctx
        )
        assert res.ok, res.error
        assert res.payload["provider"] == "kyber" and res.payload["restartRequired"] is False
        assert config.trading.provider == "kyber"
        assert kyber_service.provider_id() == "kyber"
        status = await get_dispatcher().dispatch("r2", "trading.status", {}, ctx)
        assert status.payload["provider"] == "kyber"
        bad = await get_dispatcher().dispatch(
            "r3", "trading.setProvider", {"provider": "nope"}, ctx
        )
        assert bad.ok is False
        probe = await get_dispatcher().dispatch("r4", "trading.probe", {"provider": "kyber"}, ctx)
        assert probe.ok and probe.payload["provider"] == "kyber"
