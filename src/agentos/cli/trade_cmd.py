"""``agentos trade`` — quotes, swaps, orders, history and PnL from the terminal.

A thin client over the gateway's ``trading.*`` RPCs. Every swap goes through
the engine's guardrails: a swap initiated *as the agent* (``--as-agent``, or
``AGENTOS_SESSION_KEY``/``AGENTOS_AGENT`` set in the environment, which is how
the ``wallet-trading`` skill runs) is subject to the per-order approval
threshold and the per-wallet daily cap; a swap typed by a person is not.
"""

from __future__ import annotations

import os
from typing import Any

import typer
from rich.table import Table

from agentos.cli.gateway_rpc import run_gateway_sync
from agentos.cli.output import emit_error, print_json
from agentos.cli.ui import ACCENT, ACCENT_HEADER, console, markup_escape
from agentos.cli.wallet_cmd import (
    NATIVE_ADDRESS,
    amount_text,
    chain_id_from_arg,
    chain_label,
    is_address,
    money,
    percent,
    short_address,
    token_symbol,
)

app = typer.Typer(help="Swap tokens, track orders, history and PnL.")

AGENT_ENV_MARKERS = ("AGENTOS_SESSION_KEY", "AGENTOS_AGENT")
PROVIDERS: dict[str, str] = {"aggregator": "AgentOS Aggregator", "uniswap": "Uniswap"}
# Statuses that still move on their own after ``trading.swap`` returns.
_PENDING_STATUSES = frozenset({"awaiting_approval", "approved", "submitted", "quoted"})


class TokenResolutionError(Exception):
    """A symbol did not resolve to exactly one verified token."""

    def __init__(self, message: str, *, code: str = "TOKEN_UNRESOLVED") -> None:
        super().__init__(message)
        self.code = code


def provider_id_from_arg(value: str) -> str:
    """Normalise ``aggregator``/``uniswap`` (case-insensitive; ``agg`` accepted)."""

    key = value.strip().lower()
    if key in ("agg", "404", "agentos"):
        key = "aggregator"
    if key not in PROVIDERS:
        choices = ", ".join(PROVIDERS)
        raise typer.BadParameter(f"unknown provider {value!r}; expected one of: {choices}")
    return key


def provider_label(value: Any) -> str:
    key = str(value or "").strip().lower()
    return PROVIDERS.get(key, key or "—")


def initiator_for(as_agent: bool, environ: dict[str, str] | None = None) -> str:
    """``agent`` when forced or when running inside an agent turn, else ``manual``."""

    env = os.environ if environ is None else environ
    if as_agent:
        return "agent"
    if any(env.get(name, "").strip() for name in AGENT_ENV_MARKERS):
        return "agent"
    return "manual"


async def resolve_token(client: Any, chain_id: int, value: str) -> str:
    """Turn ``ETH``, an address, or a symbol into a token address.

    Symbols must match exactly one *verified* token on the chain; anything
    else raises so the caller never swaps into a lookalike by accident. An
    address is passed through untouched — the engine resolves its metadata.
    """

    text = value.strip()
    if not text:
        raise TokenResolutionError("token cannot be empty")
    if text.upper() == "ETH":
        return NATIVE_ADDRESS
    if is_address(text):
        return text
    result = await client.call("trading.tokens.search", {"chainId": chain_id, "query": text})
    tokens = result.get("tokens", []) if isinstance(result, dict) else []
    matches = [
        t
        for t in tokens
        if isinstance(t, dict) and str(t.get("symbol") or "").upper() == text.upper()
    ]
    if not matches:
        raise TokenResolutionError(
            f"no token with symbol {text!r} on {chain_label(chain_id)}; pass its address",
            code="TOKEN_NOT_FOUND",
        )
    verified = [t for t in matches if t.get("verified")]
    if len(verified) == 1:
        return str(verified[0]["address"])
    if not verified:
        listed = ", ".join(str(t.get("address")) for t in matches[:5])
        raise TokenResolutionError(
            f"{text!r} matched only unverified tokens on {chain_label(chain_id)} ({listed}); "
            "pass the address explicitly if you mean one of them",
            code="TOKEN_UNVERIFIED",
        )
    listed = ", ".join(str(t.get("address")) for t in verified[:5])
    raise TokenResolutionError(
        f"{text!r} is ambiguous on {chain_label(chain_id)} ({listed}); pass the address",
        code="TOKEN_AMBIGUOUS",
    )


def _exit_token_error(exc: TokenResolutionError, *, json_output: bool) -> None:
    emit_error(str(exc), json_output=json_output, code=exc.code)
    raise typer.Exit(2)


def _bad_argument(message: str, *, json_output: bool) -> None:
    """An argument error an agent can parse: JSON on stderr, exit 2.

    ``typer.BadParameter`` prints a usage panel, which is right for a person
    and useless for ``--json`` callers reading stderr for ``{"error": …}``.
    """
    emit_error(message, json_output=json_output, code="INVALID_ARGUMENT")
    raise typer.Exit(2)


def _dict(value: Any) -> dict[str, Any]:
    """Narrow an RPC payload (or one of its fields) to a dict for rendering."""

    return value if isinstance(value, dict) else {}


def _order_rows(result: Any) -> list[dict[str, Any]]:
    orders = result.get("orders", []) if isinstance(result, dict) else []
    return [o for o in orders if isinstance(o, dict)]


def _order_table(orders: list[dict[str, Any]], title: str = "Orders") -> Table:
    table = Table(title=title, show_header=True, header_style=ACCENT_HEADER)
    table.add_column("Order")
    table.add_column("Chain")
    table.add_column("Wallet")
    table.add_column("Swap")
    table.add_column("Value", justify="right")
    table.add_column("Status")
    table.add_column("Tx / reason")
    for order in orders:
        swap = (
            f"{amount_text(order.get('amountIn'))} {token_symbol(order.get('tokenIn'))} → "
            f"{token_symbol(order.get('tokenOut'))}"
        )
        tail = order.get("txHash") or order.get("reason") or ""
        table.add_row(
            str(order.get("orderId") or ""),
            chain_label(order.get("chainId")),
            short_address(order.get("wallet")),
            markup_escape(swap),
            money(order.get("valueUsd")),
            str(order.get("status") or ""),
            markup_escape(str(tail)),
        )
    return table


def _print_order(order: dict[str, Any]) -> None:
    table = Table(title=f"Order {order.get('orderId') or ''}", show_header=False)
    table.add_column("Field", style=ACCENT)
    table.add_column("Value")
    for field, value in (
        ("status", order.get("status")),
        ("reason", order.get("reason")),
        ("chain", chain_label(order.get("chainId"))),
        ("wallet", order.get("wallet")),
        ("in", f"{amount_text(order.get('amountIn'))} {token_symbol(order.get('tokenIn'))}"),
        (
            "out",
            f"{amount_text(order.get('expectedOut'))} {token_symbol(order.get('tokenOut'))}",
        ),
        ("min out", order.get("minOut")),
        ("value", money(order.get("valueUsd"))),
        ("price impact", percent(order.get("priceImpactPct"))),
        ("gas", money(order.get("gasUsd"))),
        ("initiator", order.get("initiator")),
        ("tx", order.get("txHash")),
        ("explorer", order.get("explorerUrl")),
        ("expires", order.get("expiresAt")),
        ("note", order.get("note")),
    ):
        if value in (None, "", "—"):
            continue
        table.add_row(field, markup_escape(str(value)))
    console.print(table)


# ── commands ────────────────────────────────────────────────────────────────


@app.command("status")
def trade_status(
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Show trading readiness: API key, chains, limits, vault state."""

    async def _run(client):
        return await client.call("trading.status", {})

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        return
    result = _dict(result)
    limits = _dict(result.get("limits"))
    table = Table(title="Trading", show_header=False)
    table.add_column("Field", style=ACCENT)
    table.add_column("Value")
    table.add_row("enabled", "yes" if result.get("enabled") else "no")
    table.add_row("provider", provider_label(result.get("provider")))
    table.add_row("Uniswap API key", "configured" if result.get("apiKeyConfigured") else "missing")
    table.add_row("vault", "unlocked" if result.get("unlocked") else "locked")
    table.add_row("unlock mode", str(result.get("unlockMode") or "—"))
    table.add_row("approval threshold", money(limits.get("approvalThresholdUsd")))
    table.add_row("daily cap / wallet", money(limits.get("dailyCapUsd")))
    table.add_row("approval TTL", f"{limits.get('approvalTtlSeconds', '—')} s")
    table.add_row("syncing", "yes" if result.get("syncing") else "no")
    console.print(table)
    providers = result.get("providers", [])
    if isinstance(providers, list) and providers:
        pt = Table(title="Swap providers", show_header=True, header_style=ACCENT_HEADER)
        pt.add_column("Provider")
        pt.add_column("Active")
        pt.add_column("API key")
        pt.add_column("Reachable")
        for entry in providers:
            if not isinstance(entry, dict):
                continue
            healthy = entry.get("healthy")
            reachable = "—" if healthy is None else ("yes" if healthy else "no")
            if entry.get("needsKey"):
                key_state = "configured" if entry.get("keyConfigured") else "missing"
            else:
                key_state = "not needed"
            pt.add_row(
                str(entry.get("label") or entry.get("id") or ""),
                "★" if entry.get("id") == result.get("provider") else "",
                key_state,
                reachable,
            )
        console.print(pt)
    chains = result.get("chains", [])
    if isinstance(chains, list) and chains:
        ct = Table(title="Chains", show_header=True, header_style=ACCENT_HEADER)
        ct.add_column("Chain")
        ct.add_column("Id")
        ct.add_column("RPC")
        ct.add_column("Healthy")
        for chain in chains:
            if not isinstance(chain, dict):
                continue
            healthy = chain.get("healthy")
            ct.add_row(
                str(chain.get("name") or chain.get("key") or ""),
                str(chain.get("chainId") or ""),
                markup_escape(str(chain.get("rpcUrl") or "")),
                "—" if healthy is None else ("yes" if healthy else "no"),
            )
        console.print(ct)


@app.command("probe")
def trade_probe(
    provider: str | None = typer.Option(
        None, "--provider", help="aggregator or uniswap (default: the configured provider)"
    ),
    api_key: str | None = typer.Option(
        None, "--api-key", help="Test this Uniswap key instead of the configured one"
    ),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Check that the swap provider is reachable (and, for Uniswap, that the key works)."""

    params: dict[str, Any] = {}
    if provider:
        params["provider"] = provider_id_from_arg(provider)
    if api_key:
        params["apiKey"] = api_key

    async def _run(client):
        return await client.call("trading.probe", params)

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        if isinstance(result, dict) and not result.get("ok"):
            raise typer.Exit(1)
        return
    result = _dict(result)
    name = provider_label(result.get("provider") or params.get("provider"))
    if result.get("ok"):
        latency = result.get("latencyMs")
        suffix = f" ({latency} ms)" if latency is not None else ""
        console.print(f"[green]{name} OK[/]{suffix}")
        return
    console.print(f"[red]{name} failed:[/] {markup_escape(str(result.get('error')))}")
    raise typer.Exit(1)


@app.command("provider")
def trade_provider(
    name: str | None = typer.Argument(
        None, help="aggregator or uniswap (omit to show the current one)"
    ),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Show or switch the swap provider (the aggregator needs no key; Uniswap needs one)."""

    if name is None:

        async def _show(client):
            return await client.call("trading.status", {})

        result = _dict(run_gateway_sync(_show, json_output=json_output))
        current = result.get("provider")
        if json_output:
            print_json({"provider": current, "providers": result.get("providers", [])})
            return
        console.print(f"Swap provider: [{ACCENT}]{provider_label(current)}[/]")
        return

    provider = provider_id_from_arg(name)

    async def _set(client):
        return await client.call("config.set", {"path": "trading.provider", "value": provider})

    result = _dict(run_gateway_sync(_set, json_output=json_output))
    if json_output:
        print_json({"provider": provider, **result})
        return
    console.print(f"Swap provider is now [{ACCENT}]{provider_label(provider)}[/].")
    if provider == "uniswap":
        console.print(
            "Uniswap needs an API key in `trading.uniswap_api_key` (or UNISWAP_API_KEY). "
            "Run `agentos trade probe --provider uniswap` to check it from here."
        )
    elif result.get("restartRequired"):
        console.print("Restart the gateway to apply.")


@app.command("tokens")
def trade_tokens(
    query: str = typer.Argument(..., help="Symbol, name, or address"),
    chain: str = typer.Option(..., "--chain", help="base or robinhood"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Search tokens on a chain (verified Robinhood Stock Tokens are flagged)."""

    chain_id = chain_id_from_arg(chain)

    async def _run(client):
        return await client.call("trading.tokens.search", {"chainId": chain_id, "query": query})

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        return
    rows = result.get("tokens", []) if isinstance(result, dict) else []
    table = Table(
        title=f"Tokens on {chain_label(chain_id)}", show_header=True, header_style=ACCENT_HEADER
    )
    table.add_column("Symbol")
    table.add_column("Name")
    table.add_column("Address")
    table.add_column("Price", justify="right")
    table.add_column("Liquidity", justify="right")
    table.add_column("Verified")
    for row in rows:
        if not isinstance(row, dict):
            continue
        table.add_row(
            markup_escape(str(row.get("symbol") or "")),
            markup_escape(str(row.get("name") or "")),
            str(row.get("address") or ""),
            money(row.get("priceUsd")),
            money(row.get("liquidityUsd")),
            "✓" if row.get("verified") else "",
        )
    console.print(table)


def _set_hidden(chain: str, address: str, hidden: bool, json_output: bool) -> None:
    chain_id = chain_id_from_arg(chain)

    async def _run(client):
        return await client.call(
            "trading.tokens.hide", {"chainId": chain_id, "address": address, "hidden": hidden}
        )

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        return
    token = _dict(_dict(result).get("token"))
    symbol = markup_escape(str(token.get("symbol") or token.get("address") or address))
    verb = "Hidden" if token.get("hidden") else "Shown"
    console.print(f"{verb}: {symbol} on {chain_label(chain_id)}")


@app.command("hide")
def trade_hide(
    address: str = typer.Argument(..., help="Token address"),
    chain: str = typer.Option(..., "--chain", help="base or robinhood"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Hide a token from balances, portfolio and history (the ledger keeps it)."""

    _set_hidden(chain, address, True, json_output)


@app.command("unhide")
def trade_unhide(
    address: str = typer.Argument(..., help="Token address"),
    chain: str = typer.Option(..., "--chain", help="base or robinhood"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Show a token again; the engine will not auto-hide it after this."""

    _set_hidden(chain, address, False, json_output)


@app.command("quote")
def trade_quote(
    chain: str = typer.Option(..., "--chain", help="base or robinhood"),
    token_in: str = typer.Option(..., "--in", help="Token to sell: symbol, address, or ETH"),
    token_out: str = typer.Option(..., "--out", help="Token to buy: symbol, address, or ETH"),
    amount: str | None = typer.Option(None, "--amount", help="Amount of --in to sell, human units"),
    usd: float | None = typer.Option(
        None, "--usd", help="Sell this many US dollars' worth of --in"
    ),
    wallet: str | None = typer.Option(None, "--wallet", help="Wallet address (default primary)"),
    slippage: float | None = typer.Option(None, "--slippage", help="Slippage %, default auto"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Get a swap quote without executing anything."""

    if (amount is None) == (usd is None):
        _bad_argument("Use exactly one of --amount or --usd", json_output=json_output)
    if usd is not None and usd <= 0:
        _bad_argument("--usd must be above 0", json_output=json_output)
    chain_id = chain_id_from_arg(chain)
    # The gateway decides who is asking from the connection itself; this is
    # the fallback declaration so a quote inside an agent turn carries the
    # agent's guard verdict (threshold, cap) instead of a manual "allow".
    initiator = initiator_for(False)

    async def _run(client):
        params: dict[str, Any] = {
            "chainId": chain_id,
            "tokenIn": await resolve_token(client, chain_id, token_in),
            "tokenOut": await resolve_token(client, chain_id, token_out),
            "initiator": initiator,
        }
        if amount is not None:
            params["amountIn"] = amount
        else:
            params["amountUsd"] = usd
        if wallet:
            params["wallet"] = wallet
        if slippage is not None:
            params["slippagePct"] = slippage
        return await client.call("trading.quote", params)

    try:
        result = run_gateway_sync(_run, json_output=json_output)
    except TokenResolutionError as exc:
        _exit_token_error(exc, json_output=json_output)
        return
    if json_output:
        print_json(result)
        return
    result = _dict(result)
    guard = _dict(result.get("guard"))
    table = Table(title="Quote", show_header=False)
    table.add_column("Field", style=ACCENT)
    table.add_column("Value")
    table.add_row(
        "sell", f"{amount_text(result.get('amountIn'))} {token_symbol(result.get('tokenIn'))}"
    )
    table.add_row(
        "receive", f"{amount_text(result.get('amountOut'))} {token_symbol(result.get('tokenOut'))}"
    )
    table.add_row("minimum", amount_text(result.get("minOut")))
    table.add_row("rate", amount_text(result.get("rate")))
    table.add_row("value", money(result.get("valueUsd")))
    table.add_row("price impact", percent(result.get("priceImpactPct")))
    table.add_row("gas", money(result.get("gasUsd")))
    table.add_row("slippage", percent(result.get("slippagePct")))
    table.add_row("routing", str(result.get("routing") or "—"))
    table.add_row("expires", str(result.get("expiresAt") or "—"))
    if guard:
        table.add_row(
            "guardrail",
            f"{guard.get('decision')} (spent today {money(guard.get('spentTodayUsd'))} "
            f"of {money(guard.get('dailyCapUsd'))}; threshold {money(guard.get('thresholdUsd'))})",
        )
    console.print(table)


@app.command("swap")
def trade_swap(
    chain: str = typer.Option(..., "--chain", help="base or robinhood"),
    token_in: str = typer.Option(..., "--in", help="Token to sell: symbol, address, or ETH"),
    token_out: str = typer.Option(..., "--out", help="Token to buy: symbol, address, or ETH"),
    amount: str | None = typer.Option(None, "--amount", help="Amount of --in, human units"),
    pct: float | None = typer.Option(
        None, "--pct", help="Percent of the --in balance (above 0, up to 100; fractions allowed)"
    ),
    usd: float | None = typer.Option(
        None, "--usd", help="Sell this many US dollars' worth of --in"
    ),
    wallets: list[str] | None = typer.Option(
        None, "--wallet", help="Wallet address (repeatable; default primary)"
    ),
    all_wallets: bool = typer.Option(False, "--all-wallets", help="Swap from every wallet"),
    slippage: float | None = typer.Option(None, "--slippage", help="Slippage %, default auto"),
    note: str | None = typer.Option(None, "--note", help="Why this swap (kept in history)"),
    wait: bool = typer.Option(False, "--wait", help="Block until each order settles"),
    wait_seconds: int = typer.Option(
        300, "--wait-seconds", help="How long --wait blocks per order", min=1, max=900
    ),
    as_agent: bool = typer.Option(
        False, "--as-agent", help="Apply the agent guardrails (threshold, daily cap)"
    ),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Swap tokens from one, several, or all wallets."""

    if sum(v is not None for v in (amount, pct, usd)) != 1:
        _bad_argument("Use exactly one of --amount, --pct or --usd", json_output=json_output)
    if pct is not None and not 0 < pct <= 100:
        _bad_argument("--pct must be above 0 and at most 100", json_output=json_output)
    if usd is not None and usd <= 0:
        _bad_argument("--usd must be above 0", json_output=json_output)
    if all_wallets and wallets:
        _bad_argument("Use either --wallet or --all-wallets, not both", json_output=json_output)
    chain_id = chain_id_from_arg(chain)
    initiator = initiator_for(as_agent)
    session_key = os.environ.get("AGENTOS_SESSION_KEY", "").strip()

    async def _run(client):
        params: dict[str, Any] = {
            "chainId": chain_id,
            "tokenIn": await resolve_token(client, chain_id, token_in),
            "tokenOut": await resolve_token(client, chain_id, token_out),
            "initiator": initiator,
        }
        if amount is not None:
            params["amountIn"] = amount
        elif pct is not None:
            params["amountPct"] = pct
        else:
            params["amountUsd"] = usd
        if all_wallets:
            params["wallets"] = "all"
        elif wallets:
            params["wallets"] = list(wallets)
        if slippage is not None:
            params["slippagePct"] = slippage
        if note:
            params["note"] = note
        if session_key:
            params["sessionKey"] = session_key
        result = await client.call("trading.swap", params)
        if not wait:
            return result
        settled: list[dict[str, Any]] = []
        for order in _order_rows(result):
            order_id = order.get("orderId")
            if order_id and order.get("status") in _PENDING_STATUSES:
                waited = await client.call(
                    "trading.orders.wait", {"orderId": order_id, "timeoutSeconds": wait_seconds}
                )
                waited_order = waited.get("order") if isinstance(waited, dict) else None
                settled.append(waited_order if isinstance(waited_order, dict) else order)
            else:
                settled.append(order)
        return {"orders": settled}

    try:
        result = run_gateway_sync(_run, json_output=json_output)
    except TokenResolutionError as exc:
        _exit_token_error(exc, json_output=json_output)
        return
    if json_output:
        print_json(result)
        return
    orders = _order_rows(result)
    console.print(_order_table(orders, title=f"Swap ({initiator})"))
    for order in orders:
        if order.get("status") == "awaiting_approval":
            console.print(
                f"Order [{ACCENT}]{order.get('orderId')}[/] is waiting for approval in the app "
                f"(or: agentos trade approve {order.get('orderId')})."
            )


@app.command("orders")
def trade_orders(
    status: str | None = typer.Option(None, "--status", help="Filter by status"),
    wallet: str | None = typer.Option(None, "--wallet", help="Filter by wallet address"),
    limit: int = typer.Option(50, "--limit", help="Max rows", min=1, max=500),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """List recent orders (pending approvals first)."""

    params: dict[str, Any] = {"limit": limit}
    if status:
        params["status"] = status
    if wallet:
        params["wallet"] = wallet

    async def _run(client):
        return await client.call("trading.orders.list", params)

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        return
    orders = _order_rows(result)
    console.print(_order_table(orders))
    pending = result.get("pendingApprovals") if isinstance(result, dict) else None
    if pending:
        console.print(f"{pending} order(s) awaiting approval.")


@app.command("order")
def trade_order(
    order_id: str = typer.Argument(..., help="Order id"),
    wait: bool = typer.Option(False, "--wait", help="Block until the order settles"),
    wait_seconds: int = typer.Option(300, "--wait-seconds", min=1, max=900),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Show one order, optionally waiting for it to settle."""

    async def _run(client):
        if wait:
            return await client.call(
                "trading.orders.wait", {"orderId": order_id, "timeoutSeconds": wait_seconds}
            )
        return await client.call("trading.orders.get", {"orderId": order_id})

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        return
    order = result.get("order") if isinstance(result, dict) else None
    _print_order(order if isinstance(order, dict) else {})


@app.command("approve")
def trade_approve(
    order_id: str = typer.Argument(..., help="Order id awaiting approval"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Approve an order the agent queued above the threshold."""

    async def _run(client):
        return await client.call("trading.orders.approve", {"orderId": order_id})

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        return
    order = result.get("order") if isinstance(result, dict) else None
    _print_order(order if isinstance(order, dict) else {})


@app.command("reject")
def trade_reject(
    order_id: str = typer.Argument(..., help="Order id awaiting approval"),
    reason: str | None = typer.Option(None, "--reason", help="Why (returned to the agent)"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Reject a queued order."""

    params: dict[str, Any] = {"orderId": order_id}
    if reason:
        params["reason"] = reason

    async def _run(client):
        return await client.call("trading.orders.reject", params)

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        return
    order = result.get("order") if isinstance(result, dict) else None
    _print_order(order if isinstance(order, dict) else {})


@app.command("history")
def trade_history(
    wallet: str | None = typer.Option(None, "--wallet", help="Filter by wallet address"),
    chain: str | None = typer.Option(None, "--chain", help="base or robinhood"),
    kind: str | None = typer.Option(None, "--kind", help="swap, deposit, withdraw, gas, approval"),
    limit: int = typer.Option(100, "--limit", help="Max rows", min=1, max=1000),
    hidden: bool = typer.Option(False, "--hidden", help="Include entries of hidden (junk) tokens"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Show the ledger: swaps, deposits, withdrawals, approvals."""

    params: dict[str, Any] = {"limit": limit}
    if wallet:
        params["wallet"] = wallet
    if chain:
        params["chainId"] = chain_id_from_arg(chain)
    if kind:
        params["kind"] = kind
    if hidden:
        params["includeHidden"] = True

    async def _run(client):
        return await client.call("trading.history", params)

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        return
    rows = result.get("entries", []) if isinstance(result, dict) else []
    table = Table(title="History", show_header=True, header_style=ACCENT_HEADER)
    table.add_column("When")
    table.add_column("Kind")
    table.add_column("Chain")
    table.add_column("Wallet")
    table.add_column("In")
    table.add_column("Out")
    table.add_column("Value", justify="right")
    table.add_column("Gas", justify="right")
    table.add_column("By")
    table.add_column("Tx")
    for row in rows:
        if not isinstance(row, dict):
            continue
        token_in = row.get("tokenIn")
        token_out = row.get("tokenOut")
        table.add_row(
            str(row.get("ts") or ""),
            str(row.get("kind") or ""),
            chain_label(row.get("chainId")),
            short_address(row.get("wallet")),
            markup_escape(
                f"{amount_text(row.get('amountIn'))} {token_symbol(token_in)}" if token_in else "—"
            ),
            markup_escape(
                f"{amount_text(row.get('amountOut'))} {token_symbol(token_out)}"
                if token_out
                else "—"
            ),
            money(row.get("valueUsd")),
            money(row.get("gasUsd")),
            str(row.get("initiator") or ""),
            short_address(row.get("txHash")) if row.get("txHash") else "",
        )
    console.print(table)


@app.command("portfolio")
def trade_portfolio(
    wallet: str | None = typer.Option(None, "--wallet", help="One wallet (default: all)"),
    hidden: bool = typer.Option(False, "--hidden", help="Include hidden (junk) tokens"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Holdings with cost basis, realized and unrealized PnL."""

    params: dict[str, Any] = {}
    if wallet:
        params["wallet"] = wallet
    if hidden:
        params["includeHidden"] = True

    async def _run(client):
        return await client.call("trading.portfolio", params)

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        return
    result = _dict(result)
    totals = _dict(result.get("totals"))
    summary = Table(title="Portfolio", show_header=False)
    summary.add_column("Field", style=ACCENT)
    summary.add_column("Value", justify="right")
    summary.add_row("value", money(totals.get("valueUsd")))
    summary.add_row("cost", money(totals.get("costUsd")))
    summary.add_row("unrealized", money(totals.get("unrealizedUsd")))
    summary.add_row("realized", money(totals.get("realizedUsd")))
    summary.add_row("gas", money(totals.get("gasUsd")))
    summary.add_row(
        "24h",
        f"{money(totals.get('change24hUsd'))} ({percent(totals.get('change24hPct'))})",
    )
    console.print(summary)
    holdings = result.get("holdings", [])
    table = Table(title="Holdings", show_header=True, header_style=ACCENT_HEADER)
    table.add_column("Chain")
    table.add_column("Token")
    table.add_column("Amount", justify="right")
    table.add_column("Price", justify="right")
    table.add_column("Value", justify="right")
    table.add_column("Avg cost", justify="right")
    table.add_column("Unrealized", justify="right")
    table.add_column("Realized", justify="right")
    table.add_column("Alloc", justify="right")
    for row in holdings if isinstance(holdings, list) else []:
        if not isinstance(row, dict):
            continue
        symbol = markup_escape(token_symbol(row.get("token")))
        table.add_row(
            chain_label(row.get("chainId")),
            f"[dim]{symbol} (hidden)[/dim]" if row.get("hidden") else symbol,
            amount_text(row.get("amount")),
            money(row.get("priceUsd")),
            money(row.get("valueUsd")),
            money(row.get("avgCostUsd")),
            f"{money(row.get('unrealizedUsd'))} ({percent(row.get('unrealizedPct'))})",
            money(row.get("realizedUsd")),
            percent(row.get("allocationPct")),
        )
    console.print(table)
    hidden_count = int(result.get("hiddenCount") or 0)
    if hidden_count and not hidden:
        noun = "token" if hidden_count == 1 else "tokens"
        console.print(
            f"[dim]{hidden_count} junk {noun} hidden and not counted; add --hidden to list "
            "them, or `agentos trade unhide` to keep one.[/dim]"
        )
    if result.get("syncing"):
        console.print("Ledger sync in progress; numbers may still move.")


@app.command("sync")
def trade_sync(
    wallet: str | None = typer.Option(None, "--wallet", help="One wallet (default: all)"),
    full: bool = typer.Option(False, "--full", help="Rebuild lots and history from the chain"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Re-read the chain into the ledger."""

    params: dict[str, Any] = {"full": full}
    if wallet:
        params["wallet"] = wallet

    async def _run(client):
        return await client.call("trading.sync", params)

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        return
    console.print("Sync started." + (" Full rebuild." if full else ""))


@app.command("limits")
def trade_limits(
    wallet: str | None = typer.Argument(None, help="Wallet address (default: the primary wallet)"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
) -> None:
    """Show the agent guardrails and today's spend for a wallet."""

    async def _run(client):
        target = wallet
        if not target:
            status = await client.call("wallet.status", {})
            target = (status or {}).get("primary") if isinstance(status, dict) else None
            if not target:
                _bad_argument("No primary wallet; pass a wallet address", json_output=json_output)
        return await client.call("trading.limits", {"wallet": target})

    result = run_gateway_sync(_run, json_output=json_output)
    if json_output:
        print_json(result)
        return
    result = result if isinstance(result, dict) else {}
    shown = str(wallet or result.get("wallet") or "")
    table = Table(title=f"Limits for {short_address(shown)}", show_header=False)
    table.add_column("Field", style=ACCENT)
    table.add_column("Value", justify="right")
    table.add_row("daily cap", money(result.get("dailyCapUsd")))
    table.add_row("spent today", money(result.get("spentTodayUsd")))
    table.add_row("approval threshold", money(result.get("thresholdUsd")))
    table.add_row("approval TTL", f"{result.get('approvalTtlSeconds', '—')} s")
    console.print(table)
