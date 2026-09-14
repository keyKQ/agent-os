"""``wallet.*`` and ``trading.*`` RPC — the engine side of the Trading page.

Thin handlers: validate params, call :class:`agentos.trading.service.TradingService`,
map its coded errors to :class:`RpcHandlerError`. The service is a lazy
module singleton built from ``ctx.config`` on first use; its background
sync/expiry loop starts the first time a handler runs on a live event loop.
Control-plane only.
"""

from __future__ import annotations

from typing import Any

from agentos.gateway.rpc import RpcContext, RpcHandlerError, get_dispatcher
from agentos.trading import get_trading_service
from agentos.trading.chains import ChainSpec, resolve_chain
from agentos.trading.providers import PROVIDER_IDS
from agentos.trading.service import (
    DEFAULT_CHART_RANGE,
    TradingError,
    TradingService,
    _err,
)

_d = get_dispatcher()

_VALID_EXPORT_FORMATS = {"keystore", "privateKey"}
_VALID_INITIATORS = {"manual", "agent"}


async def _broadcast(event: str, payload: dict[str, Any]) -> None:
    """Fan an engine event out to every authenticated WebSocket connection."""
    from agentos.gateway.websocket import get_registry

    try:
        await get_registry().broadcast(event, payload)
    except Exception:  # pragma: no cover - best effort
        pass


def _service(ctx: RpcContext) -> TradingService:
    service = get_trading_service(ctx.config, broadcast=_broadcast)
    service.ensure_started()
    return service


def _params(params: dict | None) -> dict[str, Any]:
    return params if isinstance(params, dict) else {}


def _str(params: dict[str, Any], key: str, *, required: bool = False) -> str | None:
    value = params.get(key)
    if value is None or value == "":
        if required:
            raise ValueError(f"params.{key} is required")
        return None
    if not isinstance(value, str):
        raise ValueError(f"params.{key} must be a string")
    return value.strip()


def _number(params: dict[str, Any], key: str) -> float | None:
    value = params.get(key)
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError(f"params.{key} must be a number")
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"params.{key} must be a number") from exc


def _int(params: dict[str, Any], key: str, default: int) -> int:
    value = params.get(key)
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        raise ValueError(f"params.{key} must be an integer")
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"params.{key} must be an integer") from exc


def _chain(params: dict[str, Any], *, required: bool = True) -> ChainSpec | None:
    value = params.get("chainId", params.get("chain"))
    if value is None or value == "":
        if required:
            raise ValueError("params.chainId is required")
        return None
    try:
        return resolve_chain(value)
    except ValueError as exc:
        raise RpcHandlerError("trading.unsupported_chain", str(exc)) from exc


def _raise(exc: Exception) -> RpcHandlerError:
    if isinstance(exc, RpcHandlerError):
        return exc
    error: TradingError = _err(exc)
    return RpcHandlerError(error.code, str(error), details=error.details)


# ── wallet.* ───────────────────────────────────────────────────────────────


@_d.method("wallet.status")
async def _wallet_status(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    service = _service(ctx)
    service.ensure_unlocked()
    return service.vault.status()


@_d.method("wallet.setup")
async def _wallet_setup(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    password = _str(p, "password", required=True) or ""
    mode = _str(p, "unlockMode") or "auto"
    if mode not in ("auto", "manual"):
        raise ValueError("params.unlockMode must be 'auto' or 'manual'")
    service = _service(ctx)
    try:
        service.vault.setup(password, mode)  # type: ignore[arg-type]
    except Exception as exc:
        raise _raise(exc) from exc
    await service._emit("trading.changed", {"reason": "wallet"})
    return {"initialized": True, **service.vault.status()}


@_d.method("wallet.unlock")
async def _wallet_unlock(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    password = _str(p, "password", required=True) or ""
    service = _service(ctx)
    try:
        service.vault.unlock(password)
    except Exception as exc:
        raise _raise(exc) from exc
    await service._emit("trading.changed", {"reason": "wallet"})
    return {"unlocked": True}


@_d.method("wallet.lock")
async def _wallet_lock(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    service = _service(ctx)
    service.vault.lock()
    await service._emit("trading.changed", {"reason": "wallet"})
    return {"unlocked": False}


@_d.method("wallet.setUnlockMode")
async def _wallet_set_unlock_mode(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    mode = _str(p, "mode", required=True) or ""
    password = _str(p, "password", required=True) or ""
    if mode not in ("auto", "manual"):
        raise ValueError("params.mode must be 'auto' or 'manual'")
    service = _service(ctx)
    try:
        service.vault.set_unlock_mode(mode, password)  # type: ignore[arg-type]
    except Exception as exc:
        raise _raise(exc) from exc
    await service._emit("trading.changed", {"reason": "wallet"})
    return {"unlockMode": mode}


@_d.method("wallet.changePassword")
async def _wallet_change_password(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    password = _str(p, "password", required=True) or ""
    new_password = _str(p, "newPassword", required=True) or ""
    service = _service(ctx)
    try:
        service.vault.change_password(password, new_password)
    except Exception as exc:
        raise _raise(exc) from exc
    return {"changed": True}


@_d.method("wallet.list")
async def _wallet_list(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    service = _service(ctx)
    service.ensure_unlocked()
    try:
        wallets = service.wallet_dicts()
        primary = service.vault.primary_address() if service.vault.initialized else None
    except Exception as exc:
        raise _raise(exc) from exc
    return {"wallets": wallets, "primary": primary}


@_d.method("wallet.create")
async def _wallet_create(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    label = _str(p, "label") or ""
    service = _service(ctx)
    try:
        return {"wallet": await service.create_wallet(label)}
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("wallet.import")
async def _wallet_import(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    label = _str(p, "label") or ""
    private_key = _str(p, "privateKey")
    keystore_json = _str(p, "keystoreJson")
    keystore_password = _str(p, "keystorePassword")
    if not private_key and not keystore_json:
        raise ValueError("params.privateKey or params.keystoreJson is required")
    service = _service(ctx)
    try:
        wallet = await service.import_wallet(
            label,
            private_key=private_key,
            keystore_json=keystore_json,
            keystore_password=keystore_password,
        )
    except Exception as exc:
        raise _raise(exc) from exc
    return {"wallet": wallet}


@_d.method("wallet.export")
async def _wallet_export(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    address = _str(p, "address", required=True) or ""
    password = _str(p, "password", required=True) or ""
    fmt = _str(p, "format") or "keystore"
    if fmt not in _VALID_EXPORT_FORMATS:
        raise ValueError("params.format must be 'keystore' or 'privateKey'")
    service = _service(ctx)
    try:
        secret = service.vault.export(address, password, fmt)  # type: ignore[arg-type]
    except Exception as exc:
        raise _raise(exc) from exc
    return {"keystoreJson": secret} if fmt == "keystore" else {"privateKey": secret}


@_d.method("wallet.rename")
async def _wallet_rename(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    address = _str(p, "address", required=True) or ""
    label = _str(p, "label", required=True) or ""
    service = _service(ctx)
    try:
        record = service.vault.rename(address, label)
        service._mirror_wallet(record)
    except Exception as exc:
        raise _raise(exc) from exc
    await service._emit("trading.changed", {"reason": "wallet", "wallet": record.address})
    primary = service.vault.primary_address()
    return {"wallet": record.to_dict(primary=(record.address == primary))}


@_d.method("wallet.remove")
async def _wallet_remove(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    address = _str(p, "address", required=True) or ""
    password = _str(p, "password", required=True) or ""
    service = _service(ctx)
    try:
        await service.remove_wallet(address, password)
    except Exception as exc:
        raise _raise(exc) from exc
    return {"removed": True}


@_d.method("wallet.setPrimary")
async def _wallet_set_primary(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    address = _str(p, "address", required=True) or ""
    service = _service(ctx)
    try:
        record = service.vault.set_primary(address)
        for item in service.vault.list():
            service._mirror_wallet(item)
    except Exception as exc:
        raise _raise(exc) from exc
    await service._emit("trading.changed", {"reason": "wallet", "wallet": record.address})
    return {"wallet": record.to_dict(primary=True)}


@_d.method("wallet.balances")
async def _wallet_balances(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    address = _str(p, "address")
    chain = _chain(p, required=False)
    service = _service(ctx)
    service.ensure_unlocked()
    try:
        rows = await service.balances(address, chain.chain_id if chain else None)
    except Exception as exc:
        raise _raise(exc) from exc
    return {"balances": rows, "updatedAt": int(service._now() * 1000)}


# ── trading.* ──────────────────────────────────────────────────────────────


@_d.method("trading.status")
async def _trading_status(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    service = _service(ctx)
    service.ensure_unlocked()
    return await service.status(check_rpc=bool(p.get("checkRpc")))


@_d.method("trading.probe")
async def _trading_probe(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    service = _service(ctx)
    try:
        return await service.probe(_str(p, "apiKey"), provider_id=_str(p, "provider"))
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.setProvider")
async def _trading_set_provider(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    """Persist ``trading.provider`` through the same path as ``config.set``.

    Convenience for the CLI; the desktop may equally call
    ``config.patch {trading: {provider}}``. Both take effect on the next
    trading call without a gateway restart.
    """
    p = _params(params)
    provider = (_str(p, "provider", required=True) or "").lower()
    if provider not in PROVIDER_IDS:
        raise ValueError("params.provider must be 'uniswap' or 'kyber'")
    result = await get_dispatcher().dispatch(
        "trading.setProvider",
        "config.set",
        {"path": "trading.provider", "value": provider},
        ctx,
    )
    if not result.ok:
        message = result.error.message if result.error else "config write failed"
        code = result.error.code if result.error else "trading.error"
        raise RpcHandlerError(str(code), str(message))
    service = _service(ctx)
    await service._emit("trading.changed", {"reason": "config", "provider": provider})
    payload = result.payload if isinstance(result.payload, dict) else {}
    return {"provider": provider, "restartRequired": bool(payload.get("restartRequired"))}


@_d.method("trading.tokens.search")
async def _trading_tokens_search(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    chain = _chain(p)
    assert chain is not None
    query = _str(p, "query", required=True) or ""
    service = _service(ctx)
    try:
        return {"tokens": await service.search_tokens(chain, query)}
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.tokens.resolve")
async def _trading_tokens_resolve(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    chain = _chain(p)
    assert chain is not None
    value = _str(p, "address") or _str(p, "token", required=True) or ""
    service = _service(ctx)
    try:
        meta = await service.resolve_token(chain, value)
    except Exception as exc:
        raise _raise(exc) from exc
    return {"token": meta.to_dict()}


@_d.method("trading.quote")
async def _trading_quote(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    chain = _chain(p)
    assert chain is not None
    initiator = _str(p, "initiator") or "manual"
    if initiator not in _VALID_INITIATORS:
        raise ValueError("params.initiator must be 'manual' or 'agent'")
    service = _service(ctx)
    service.ensure_unlocked()
    try:
        return await service.quote(
            chain=chain,
            wallet=_str(p, "wallet"),
            token_in=_str(p, "tokenIn", required=True) or "",
            token_out=_str(p, "tokenOut", required=True) or "",
            amount_in=_str(p, "amountIn", required=True) or "",
            slippage_pct=_number(p, "slippagePct"),
            initiator=initiator,  # type: ignore[arg-type]
        )
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.swap")
async def _trading_swap(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    chain = _chain(p)
    assert chain is not None
    initiator = _str(p, "initiator") or "manual"
    if initiator not in _VALID_INITIATORS:
        raise ValueError("params.initiator must be 'manual' or 'agent'")
    wallets = p.get("wallets", p.get("wallet"))
    if wallets is not None and not isinstance(wallets, str | list):
        raise ValueError("params.wallets must be an address list, 'all' or omitted")
    amount_in = p.get("amountIn")
    if amount_in is not None and not isinstance(amount_in, str | int | float):
        raise ValueError("params.amountIn must be a decimal string")
    service = _service(ctx)
    try:
        orders = await service.swap(
            chain=chain,
            wallets=wallets,
            token_in=_str(p, "tokenIn", required=True) or "",
            token_out=_str(p, "tokenOut", required=True) or "",
            amount_in=str(amount_in) if amount_in is not None else None,
            amount_pct=_number(p, "amountPct"),
            slippage_pct=_number(p, "slippagePct"),
            initiator=initiator,  # type: ignore[arg-type]
            session_key=_str(p, "sessionKey"),
            note=_str(p, "note"),
            wait=bool(p.get("wait")),
        )
    except Exception as exc:
        raise _raise(exc) from exc
    return {"orders": orders}


@_d.method("trading.unwrap")
async def _trading_unwrap(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    chain = _chain(p)
    assert chain is not None
    service = _service(ctx)
    try:
        return await service.unwrap(chain, _str(p, "wallet"), _str(p, "amount"))
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.orders.list")
async def _trading_orders_list(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    service = _service(ctx)
    try:
        return service.list_orders(
            status=_str(p, "status"), wallet=_str(p, "wallet"), limit=_int(p, "limit", 50)
        )
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.orders.get")
async def _trading_orders_get(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    order_id = _str(p, "orderId", required=True) or ""
    service = _service(ctx)
    try:
        return {"order": service.get_order(order_id)}
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.orders.wait")
async def _trading_orders_wait(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    order_id = _str(p, "orderId", required=True) or ""
    timeout = _number(p, "timeoutSeconds")
    service = _service(ctx)
    try:
        order = await service.wait_order(order_id, timeout if timeout is not None else 60.0)
    except Exception as exc:
        raise _raise(exc) from exc
    return {"order": order}


@_d.method("trading.orders.approve")
async def _trading_orders_approve(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    order_id = _str(p, "orderId", required=True) or ""
    service = _service(ctx)
    try:
        return {"order": await service.approve(order_id, wait=bool(p.get("wait")))}
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.orders.reject")
async def _trading_orders_reject(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    order_id = _str(p, "orderId", required=True) or ""
    service = _service(ctx)
    try:
        return {"order": await service.reject(order_id, _str(p, "reason"))}
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.history")
async def _trading_history(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    chain = _chain(p, required=False)
    before = _number(p, "before")
    service = _service(ctx)
    try:
        return service.history(
            wallet=_str(p, "wallet"),
            chain_id=chain.chain_id if chain else None,
            kind=_str(p, "kind"),
            limit=_int(p, "limit", 100),
            before=before / 1000.0 if before is not None and before > 10**11 else before,
        )
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.portfolio")
async def _trading_portfolio(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    service = _service(ctx)
    service.ensure_unlocked()
    try:
        return await service.portfolio(_str(p, "wallet"))
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.chart")
async def _trading_chart(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    chain = _chain(p)
    assert chain is not None
    token = _str(p, "token", required=True) or ""
    range_key = _str(p, "range") or DEFAULT_CHART_RANGE
    service = _service(ctx)
    try:
        return await service.chart(chain, token, range_key)
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.sync")
async def _trading_sync(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    service = _service(ctx)
    service.ensure_unlocked()
    try:
        service.request_sync(wallet=_str(p, "wallet"), full=bool(p.get("full")))
    except Exception as exc:
        raise _raise(exc) from exc
    return {"started": True}


@_d.method("trading.limits")
async def _trading_limits(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    service = _service(ctx)
    try:
        return service.limits(_str(p, "wallet"))
    except Exception as exc:
        raise _raise(exc) from exc


@_d.method("trading.lot.setCost")
async def _trading_lot_set_cost(params: dict | None, ctx: RpcContext) -> dict[str, Any]:
    p = _params(params)
    entry_id = _int(p, "entryId", 0)
    cost = _number(p, "costUsdPerToken")
    if entry_id <= 0:
        raise ValueError("params.entryId is required")
    if cost is None or cost < 0:
        raise ValueError("params.costUsdPerToken must be a non-negative number")
    service = _service(ctx)
    try:
        entry = service.set_lot_cost(entry_id, cost)
    except Exception as exc:
        raise _raise(exc) from exc
    await service._emit("trading.changed", {"reason": "sync"})
    return {"entry": entry}
