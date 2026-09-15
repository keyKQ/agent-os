"""``agentos trade`` CLI surface tests.

The gateway round-trip is stubbed at ``run_gateway_sync``: these pin the RPC
names and params the CLI sends, symbol → address resolution, the
agent/manual initiator rule, ``--wait`` polling, and rendered output. The
guardrails themselves live in the engine and are tested there.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from typer.testing import CliRunner

from agentos.cli import trade_cmd
from agentos.cli.wallet_cmd import NATIVE_ADDRESS, PASSWORD_ENV

runner = CliRunner()

WALLET = "0x1111111111111111111111111111111111111111"
WALLET_B = "0x2222222222222222222222222222222222222222"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
WETH = "0x4200000000000000000000000000000000000006"
FAKE_AAPL = "0x7e86381a763f0ecca2bdf27c54eac403ddd48123"
REAL_AAPL = "0x1b0e319c6a659f002271b69db8a7df2f911c153e"

TOKENS = {
    "USDC": {"symbol": "USDC", "address": USDC, "verified": True, "name": "USD Coin"},
    "WETH": {"symbol": "WETH", "address": WETH, "verified": True, "name": "Wrapped Ether"},
}


def _order(**extra: Any) -> dict[str, Any]:
    base = {
        "orderId": "ord-1",
        "chainId": 8453,
        "wallet": WALLET,
        "tokenIn": TOKENS["USDC"],
        "tokenOut": TOKENS["WETH"],
        "amountIn": "10",
        "expectedOut": "0.0025",
        "valueUsd": 10.0,
        "status": "submitted",
        "txHash": "0xabc",
        "initiator": "manual",
    }
    base.update(extra)
    return base


class _FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.search_results: dict[str, list[dict[str, Any]]] = {
            "usdc": [TOKENS["USDC"]],
            "weth": [TOKENS["WETH"]],
            "aapl": [
                {"symbol": "AAPL", "address": REAL_AAPL, "verified": True, "name": "Apple"},
                {"symbol": "AAPL", "address": FAKE_AAPL, "verified": False, "name": "Apple"},
            ],
            "gme": [
                {"symbol": "GME", "address": FAKE_AAPL, "verified": False},
            ],
            "dup": [
                {"symbol": "DUP", "address": USDC, "verified": True},
                {"symbol": "DUP", "address": WETH, "verified": True},
            ],
        }
        self.payloads: dict[str, Any] = {
            "config.set": {"restartRequired": False},
            "trading.status": {
                "enabled": True,
                "provider": "uniswap",
                "providers": [
                    {
                        "id": "uniswap",
                        "label": "Uniswap",
                        "needsKey": True,
                        "keyConfigured": True,
                        "blocked": False,
                        "healthy": True,
                    },
                    {
                        "id": "kyber",
                        "label": "KyberSwap",
                        "needsKey": False,
                        "keyConfigured": False,
                        "blocked": True,
                        "healthy": None,
                    },
                ],
                "apiKeyConfigured": True,
                "unlocked": True,
                "unlockMode": "auto",
                "limits": {
                    "approvalThresholdUsd": 100,
                    "dailyCapUsd": 1000,
                    "approvalTtlSeconds": 900,
                },
                "chains": [
                    {
                        "chainId": 8453,
                        "key": "base",
                        "name": "Base",
                        "rpcUrl": "https://mainnet.base.org",
                        "healthy": True,
                    }
                ],
                "syncing": False,
            },
            "trading.probe": {"ok": True, "latencyMs": 120, "error": None},
            "trading.quote": {
                "quoteId": "q1",
                "routing": "CLASSIC",
                "tokenIn": TOKENS["USDC"],
                "tokenOut": TOKENS["WETH"],
                "amountIn": "10",
                "amountOut": "0.0025",
                "minOut": "0.00248",
                "rate": "0.00025",
                "valueUsd": 10.0,
                "priceImpactPct": 0.01,
                "gasUsd": 0.02,
                "slippagePct": 0.5,
                "expiresAt": 999,
                "guard": {
                    "decision": "allow",
                    "spentTodayUsd": 0,
                    "dailyCapUsd": 1000,
                    "thresholdUsd": 100,
                },
            },
            "trading.swap": {"orders": [_order()]},
            "trading.orders.wait": {"order": _order(status="confirmed")},
            "trading.orders.list": {"orders": [_order()], "pendingApprovals": 0},
            "trading.orders.get": {"order": _order()},
            "trading.orders.approve": {"order": _order(status="approved")},
            "trading.orders.reject": {"order": _order(status="rejected", reason="user")},
            "trading.history": {
                "entries": [
                    {
                        "id": 1,
                        "ts": 1700000000,
                        "chainId": 8453,
                        "wallet": WALLET,
                        "kind": "swap",
                        "txHash": "0xabc",
                        "tokenIn": TOKENS["USDC"],
                        "amountIn": "10",
                        "tokenOut": TOKENS["WETH"],
                        "amountOut": "0.0025",
                        "valueUsd": 10,
                        "gasUsd": 0.02,
                        "initiator": "agent",
                    }
                ],
                "nextBefore": None,
            },
            "trading.portfolio": {
                "totals": {
                    "valueUsd": 100,
                    "costUsd": 90,
                    "unrealizedUsd": 10,
                    "realizedUsd": 2,
                    "gasUsd": 0.5,
                    "change24hUsd": 1,
                    "change24hPct": 1.0,
                },
                "holdings": [
                    {
                        "chainId": 8453,
                        "token": TOKENS["WETH"],
                        "amount": "0.05",
                        "priceUsd": 2000,
                        "valueUsd": 100,
                        "avgCostUsd": 1800,
                        "unrealizedUsd": 10,
                        "unrealizedPct": 11.1,
                        "realizedUsd": 2,
                        "allocationPct": 100,
                    }
                ],
                "syncing": True,
            },
            "trading.sync": {"started": True},
            "trading.limits": {
                "dailyCapUsd": 1000,
                "spentTodayUsd": 25,
                "thresholdUsd": 100,
                "approvalTtlSeconds": 900,
            },
        }

    async def call(self, method: str, params: dict | None = None) -> Any:
        params = dict(params or {})
        self.calls.append((method, params))
        if method == "trading.tokens.search":
            return {"tokens": self.search_results.get(str(params["query"]).lower(), [])}
        return self.payloads[method]

    def calls_to(self, method: str) -> list[dict[str, Any]]:
        return [params for name, params in self.calls if name == method]


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> _FakeClient:
    fake = _FakeClient()

    def _run(action, **kwargs):
        return asyncio.run(action(fake))

    monkeypatch.setattr(trade_cmd, "run_gateway_sync", _run)
    for name in (*trade_cmd.AGENT_ENV_MARKERS, PASSWORD_ENV):
        monkeypatch.delenv(name, raising=False)
    # Rich wraps tables at 80 columns under CliRunner (and an earlier test may
    # have pinned the shared console's width); addresses must survive intact.
    monkeypatch.setenv("COLUMNS", "220")
    monkeypatch.setattr(trade_cmd.console, "_width", 220)
    return fake


def test_status_renders(client: _FakeClient) -> None:
    result = runner.invoke(trade_cmd.app, ["status"])
    assert result.exit_code == 0, result.output
    assert "configured" in result.output
    assert "$100.00" in result.output
    assert "mainnet.base.org" in result.output
    assert client.calls == [("trading.status", {})]


def test_status_shows_provider_and_provider_table(client: _FakeClient) -> None:
    result = runner.invoke(trade_cmd.app, ["status"])
    assert result.exit_code == 0, result.output
    assert "Uniswap" in result.output
    assert "KyberSwap" in result.output
    assert "blocked in your region" in result.output
    assert "not needed" in result.output
    # The active provider gets the star, the other one does not.
    lines = result.output.splitlines()
    uniswap_line = next(
        line for line in lines if "Uniswap" in line and "API key" not in line and "yes" in line
    )
    kyber_line = next(line for line in lines if "KyberSwap" in line and "not needed" in line)
    assert "★" in uniswap_line and "★" not in kyber_line


def test_probe_passes_key_and_reports(client: _FakeClient) -> None:
    ok = runner.invoke(trade_cmd.app, ["probe", "--api-key", "k1"])
    assert ok.exit_code == 0, ok.output
    assert client.calls == [("trading.probe", {"apiKey": "k1"})]
    assert "OK" in ok.output and "120 ms" in ok.output

    client.payloads["trading.probe"] = {"ok": False, "latencyMs": None, "error": "401"}
    bad = runner.invoke(trade_cmd.app, ["probe"])
    assert bad.exit_code == 1
    assert "401" in bad.output
    assert client.calls[-1] == ("trading.probe", {})


def test_probe_provider_flag_and_geo_block(client: _FakeClient) -> None:
    client.payloads["trading.probe"] = {
        "ok": True,
        "provider": "kyber",
        "latencyMs": 80,
        "error": None,
        "blocked": False,
    }
    ok = runner.invoke(trade_cmd.app, ["probe", "--provider", "KyberSwap"])
    assert ok.exit_code == 0, ok.output
    assert client.calls == [("trading.probe", {"provider": "kyber"})]
    assert "KyberSwap OK" in ok.output

    client.payloads["trading.probe"] = {
        "ok": False,
        "provider": "kyber",
        "latencyMs": None,
        "error": "HTTP 403",
        "blocked": True,
    }
    blocked = runner.invoke(trade_cmd.app, ["probe", "--provider", "kyber"])
    assert blocked.exit_code == 1
    assert "not reachable from your region" in blocked.output
    assert "agentos trade provider uniswap" in blocked.output

    as_json = runner.invoke(trade_cmd.app, ["probe", "--provider", "kyber", "--json"])
    assert as_json.exit_code == 1
    assert json.loads(as_json.stdout)["blocked"] is True

    unknown = runner.invoke(trade_cmd.app, ["probe", "--provider", "1inch"])
    assert unknown.exit_code != 0
    assert "unknown provider" in unknown.output


def test_provider_show_and_switch(client: _FakeClient) -> None:
    shown = runner.invoke(trade_cmd.app, ["provider"])
    assert shown.exit_code == 0, shown.output
    assert "Uniswap" in shown.output
    assert client.calls == [("trading.status", {})]

    shown_json = runner.invoke(trade_cmd.app, ["provider", "--json"])
    payload = json.loads(shown_json.stdout)
    assert payload["provider"] == "uniswap"
    assert [p["id"] for p in payload["providers"]] == ["uniswap", "kyber"]

    switched = runner.invoke(trade_cmd.app, ["provider", "kyber"])
    assert switched.exit_code == 0, switched.output
    assert client.calls[-1] == ("config.set", {"path": "trading.provider", "value": "kyber"})
    assert "KyberSwap" in switched.output
    assert "geo-restricted" in switched.output

    back = runner.invoke(trade_cmd.app, ["provider", "uniswap", "--json"])
    assert back.exit_code == 0, back.output
    assert json.loads(back.stdout) == {"provider": "uniswap", "restartRequired": False}

    bad = runner.invoke(trade_cmd.app, ["provider", "0x"])
    assert bad.exit_code != 0
    assert "unknown provider" in bad.output


def test_provider_helpers() -> None:
    assert trade_cmd.provider_id_from_arg("Uniswap") == "uniswap"
    assert trade_cmd.provider_id_from_arg("kyberswap") == "kyber"
    assert trade_cmd.provider_label("kyber") == "KyberSwap"
    assert trade_cmd.provider_label(None) == "—"
    assert trade_cmd.provider_label("other") == "other"


def test_tokens_search(client: _FakeClient) -> None:
    result = runner.invoke(trade_cmd.app, ["tokens", "--chain", "robinhood", "aapl"])
    assert result.exit_code == 0, result.output
    assert client.calls == [("trading.tokens.search", {"chainId": 4663, "query": "aapl"})]
    assert REAL_AAPL in result.output and "✓" in result.output


def test_quote_resolves_symbols_and_eth(client: _FakeClient) -> None:
    result = runner.invoke(
        trade_cmd.app,
        ["quote", "--chain", "base", "--in", "ETH", "--out", "usdc", "--amount", "0.01"],
    )
    assert result.exit_code == 0, result.output
    assert client.calls_to("trading.tokens.search") == [{"chainId": 8453, "query": "usdc"}]
    assert client.calls_to("trading.quote") == [
        {
            "chainId": 8453,
            "tokenIn": NATIVE_ADDRESS,
            "tokenOut": USDC,
            "amountIn": "0.01",
            "initiator": "manual",
        }
    ]
    assert "0.0025" in result.output
    assert "allow" in result.output


def test_quote_passes_wallet_and_slippage_and_address_untouched(client: _FakeClient) -> None:
    result = runner.invoke(
        trade_cmd.app,
        [
            "quote",
            "--chain",
            "base",
            "--in",
            USDC,
            "--out",
            WETH,
            "--amount",
            "10",
            "--wallet",
            WALLET,
            "--slippage",
            "1.5",
            "--json",
        ],
    )
    assert result.exit_code == 0, result.output
    assert client.calls_to("trading.tokens.search") == []
    assert client.calls_to("trading.quote") == [
        {
            "chainId": 8453,
            "tokenIn": USDC,
            "tokenOut": WETH,
            "amountIn": "10",
            "initiator": "manual",
            "wallet": WALLET,
            "slippagePct": 1.5,
        }
    ]
    assert json.loads(result.stdout)["quoteId"] == "q1"


def test_symbol_resolution_prefers_the_verified_token(client: _FakeClient) -> None:
    result = runner.invoke(
        trade_cmd.app,
        ["quote", "--chain", "robinhood", "--in", "USDC", "--out", "AAPL", "--amount", "1"],
    )
    assert result.exit_code == 0, result.output
    assert client.calls_to("trading.quote")[0]["tokenOut"] == REAL_AAPL


@pytest.mark.parametrize(
    ("symbol", "code"),
    [("GME", "TOKEN_UNVERIFIED"), ("DUP", "TOKEN_AMBIGUOUS"), ("NOPE", "TOKEN_NOT_FOUND")],
)
def test_symbol_resolution_refuses_unverified_ambiguous_missing(
    client: _FakeClient, symbol: str, code: str
) -> None:
    result = runner.invoke(
        trade_cmd.app,
        [
            "quote",
            "--chain",
            "robinhood",
            "--in",
            "USDC",
            "--out",
            symbol,
            "--amount",
            "1",
            "--json",
        ],
    )
    assert result.exit_code == 2
    assert result.stdout == ""
    assert code in result.output
    assert client.calls_to("trading.quote") == []


def test_swap_manual_by_default_with_amount(client: _FakeClient) -> None:
    result = runner.invoke(
        trade_cmd.app,
        ["swap", "--chain", "base", "--in", "USDC", "--out", "WETH", "--amount", "10"],
    )
    assert result.exit_code == 0, result.output
    assert client.calls_to("trading.swap") == [
        {
            "chainId": 8453,
            "tokenIn": USDC,
            "tokenOut": WETH,
            "initiator": "manual",
            "amountIn": "10",
        }
    ]
    assert "ord-1" in result.output and "submitted" in result.output


def test_swap_as_agent_from_env_carries_session_key(
    client: _FakeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AGENTOS_SESSION_KEY", "agent:main:webchat:abc")
    result = runner.invoke(
        trade_cmd.app,
        [
            "swap",
            "--chain",
            "base",
            "--in",
            "USDC",
            "--out",
            "WETH",
            "--pct",
            "50",
            "--wallet",
            WALLET,
            "--wallet",
            WALLET_B,
            "--slippage",
            "1",
            "--note",
            "DCA",
            "--json",
        ],
    )
    assert result.exit_code == 0, result.output
    assert client.calls_to("trading.swap") == [
        {
            "chainId": 8453,
            "tokenIn": USDC,
            "tokenOut": WETH,
            "initiator": "agent",
            "amountPct": 50.0,
            "wallets": [WALLET, WALLET_B],
            "slippagePct": 1.0,
            "note": "DCA",
            "sessionKey": "agent:main:webchat:abc",
        }
    ]


def test_swap_as_agent_flag_and_all_wallets(client: _FakeClient) -> None:
    result = runner.invoke(
        trade_cmd.app,
        [
            "swap",
            "--chain",
            "robinhood",
            "--in",
            "ETH",
            "--out",
            USDC,
            "--amount",
            "0.1",
            "--all-wallets",
            "--as-agent",
            "--json",
        ],
    )
    assert result.exit_code == 0, result.output
    params = client.calls_to("trading.swap")[0]
    assert params["initiator"] == "agent"
    assert params["wallets"] == "all"
    assert params["chainId"] == 4663
    assert "sessionKey" not in params


def test_swap_agent_env_marker_without_session_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENTOS_AGENT", "main")
    assert trade_cmd.initiator_for(False) == "agent"
    assert trade_cmd.initiator_for(False, {}) == "manual"
    assert trade_cmd.initiator_for(True, {}) == "agent"
    assert trade_cmd.initiator_for(False, {"AGENTOS_SESSION_KEY": "  "}) == "manual"


def test_swap_argument_validation(client: _FakeClient) -> None:
    common = ["swap", "--chain", "base", "--in", "USDC", "--out", "WETH"]
    assert runner.invoke(trade_cmd.app, common).exit_code != 0
    assert runner.invoke(trade_cmd.app, [*common, "--amount", "1", "--pct", "5"]).exit_code != 0
    assert runner.invoke(trade_cmd.app, [*common, "--pct", "150"]).exit_code != 0
    assert (
        runner.invoke(
            trade_cmd.app, [*common, "--amount", "1", "--wallet", WALLET, "--all-wallets"]
        ).exit_code
        != 0
    )
    assert client.calls == []


def test_swap_wait_polls_pending_orders_only(client: _FakeClient) -> None:
    client.payloads["trading.swap"] = {
        "orders": [
            _order(orderId="ord-1", status="awaiting_approval"),
            _order(orderId="ord-2", wallet=WALLET_B, status="rejected", reason="daily cap"),
        ]
    }
    result = runner.invoke(
        trade_cmd.app,
        [
            "swap",
            "--chain",
            "base",
            "--in",
            "USDC",
            "--out",
            "WETH",
            "--amount",
            "10",
            "--wait",
            "--wait-seconds",
            "30",
            "--json",
        ],
    )
    assert result.exit_code == 0, result.output
    assert client.calls_to("trading.orders.wait") == [{"orderId": "ord-1", "timeoutSeconds": 30}]
    payload = json.loads(result.stdout)
    assert [o["status"] for o in payload["orders"]] == ["confirmed", "rejected"]


def test_swap_prints_approval_hint(client: _FakeClient) -> None:
    client.payloads["trading.swap"] = {"orders": [_order(status="awaiting_approval")]}
    result = runner.invoke(
        trade_cmd.app,
        ["swap", "--chain", "base", "--in", "USDC", "--out", "WETH", "--amount", "500"],
    )
    assert result.exit_code == 0, result.output
    assert "agentos trade approve ord-1" in result.output


def test_orders_list_and_filters(client: _FakeClient) -> None:
    client.payloads["trading.orders.list"] = {
        "orders": [_order(status="awaiting_approval")],
        "pendingApprovals": 1,
    }
    result = runner.invoke(
        trade_cmd.app,
        ["orders", "--status", "awaiting_approval", "--wallet", WALLET, "--limit", "5"],
    )
    assert result.exit_code == 0, result.output
    assert client.calls == [
        ("trading.orders.list", {"limit": 5, "status": "awaiting_approval", "wallet": WALLET})
    ]
    assert "1 order(s) awaiting approval" in result.output


def test_order_get_and_wait(client: _FakeClient) -> None:
    shown = runner.invoke(trade_cmd.app, ["order", "ord-1"])
    waited = runner.invoke(trade_cmd.app, ["order", "ord-1", "--wait", "--wait-seconds", "10"])
    assert shown.exit_code == 0 and waited.exit_code == 0, waited.output
    assert client.calls == [
        ("trading.orders.get", {"orderId": "ord-1"}),
        ("trading.orders.wait", {"orderId": "ord-1", "timeoutSeconds": 10}),
    ]
    assert "0xabc" in shown.output
    assert "confirmed" in waited.output


def test_approve_and_reject(client: _FakeClient) -> None:
    approved = runner.invoke(trade_cmd.app, ["approve", "ord-1", "--json"])
    rejected = runner.invoke(trade_cmd.app, ["reject", "ord-1", "--reason", "too pricey"])
    assert approved.exit_code == 0 and rejected.exit_code == 0
    assert client.calls == [
        ("trading.orders.approve", {"orderId": "ord-1"}),
        ("trading.orders.reject", {"orderId": "ord-1", "reason": "too pricey"}),
    ]
    assert json.loads(approved.stdout)["order"]["status"] == "approved"
    assert "rejected" in rejected.output


def test_history_filters(client: _FakeClient) -> None:
    result = runner.invoke(
        trade_cmd.app,
        ["history", "--wallet", WALLET, "--chain", "base", "--kind", "swap", "--limit", "7"],
    )
    assert result.exit_code == 0, result.output
    assert client.calls == [
        ("trading.history", {"limit": 7, "wallet": WALLET, "chainId": 8453, "kind": "swap"})
    ]
    assert "USDC" in result.output and "WETH" in result.output and "agent" in result.output


def test_portfolio_renders_totals_and_holdings(client: _FakeClient) -> None:
    result = runner.invoke(trade_cmd.app, ["portfolio", "--wallet", WALLET])
    assert result.exit_code == 0, result.output
    assert client.calls == [("trading.portfolio", {"wallet": WALLET})]
    assert "$100.00" in result.output
    assert "+11.10%" in result.output
    assert "sync in progress" in result.output


def test_sync_and_limits(client: _FakeClient) -> None:
    sync = runner.invoke(trade_cmd.app, ["sync", "--full"])
    limits = runner.invoke(trade_cmd.app, ["limits", WALLET])
    assert sync.exit_code == 0 and limits.exit_code == 0
    assert client.calls == [
        ("trading.sync", {"full": True}),
        ("trading.limits", {"wallet": WALLET}),
    ]
    assert "Full rebuild" in sync.output
    assert "$25.00" in limits.output


def test_every_command_supports_json(client: _FakeClient) -> None:
    invocations = [
        ["status"],
        ["probe"],
        ["provider"],
        ["provider", "uniswap"],
        ["tokens", "--chain", "base", "usdc"],
        ["orders"],
        ["order", "ord-1"],
        ["approve", "ord-1"],
        ["reject", "ord-1"],
        ["history"],
        ["portfolio"],
        ["sync"],
        ["limits", WALLET],
    ]
    for args in invocations:
        result = runner.invoke(trade_cmd.app, [*args, "--json"])
        assert result.exit_code == 0, (args, result.output)
        json.loads(result.stdout)


def test_argument_errors_are_json_when_asked(client: _FakeClient) -> None:
    """An agent reading stderr for ``{"error": …}`` must never get a usage panel."""
    result = runner.invoke(
        trade_cmd.app,
        ["swap", "--chain", "base", "--in", "ETH", "--out", USDC, "--json"],
    )
    assert result.exit_code == 2 and result.stdout == ""
    payload = json.loads(result.stderr.strip().splitlines()[-1])
    assert payload["error"]["code"] == "INVALID_ARGUMENT"
    assert "--amount or --pct" in payload["error"]["message"]
    assert client.calls_to("trading.swap") == []
    result = runner.invoke(
        trade_cmd.app,
        ["swap", "--chain", "base", "--in", "ETH", "--out", USDC, "--pct", "0", "--json"],
    )
    assert result.exit_code == 2
    assert json.loads(result.stderr.strip().splitlines()[-1])["error"]["code"] == "INVALID_ARGUMENT"
    # Fractions of a percent are allowed.
    result = runner.invoke(
        trade_cmd.app,
        ["swap", "--chain", "base", "--in", "ETH", "--out", USDC, "--pct", "0.5", "--json"],
    )
    assert result.exit_code == 0, result.output
    assert client.calls_to("trading.swap")[0]["amountPct"] == 0.5
