"""TradingService: the one object behind ``wallet.*`` and ``trading.*``.

It owns the vault, the ledger, the price service, one EVM client per chain
and the Uniswap client, and runs the swap pipeline:

    resolve tokens → guardrails → (approval tx) → quote → swap calldata →
    sign → broadcast → receipt → ledger (entries, lots, realized, spend)

Agent-initiated swaps above the threshold park as ``awaiting_approval``
orders; the desktop approves or rejects them, and a background task expires
the ones nobody answers. Every state change is broadcast over the gateway
WebSocket so the UI never polls for it.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Awaitable, Callable
from typing import Any, Literal

import httpx
import structlog

from agentos import __version__
from agentos.trading import guardrails
from agentos.trading.chains import (
    CHAINS,
    NATIVE_ADDRESS,
    ChainSpec,
    UnsupportedChainError,
    checksum_address,
    is_native,
    normalize_address,
    redact_rpc_url,
    rpc_url_for,
)
from agentos.trading.evm import (
    EvmClient,
    EvmRpcError,
    EvmTransportError,
    pad_uint,
    receipt_gas_wei,
    receipt_succeeded,
    receipt_transfers,
)
from agentos.trading.kyber import KyberClient, KyberProvider
from agentos.trading.ledger import (
    ORDER_FINAL_STATUSES,
    Ledger,
    local_day,
    new_order_id,
)
from agentos.trading.pnl import (
    format_amount,
    holding_from_lots,
    per_raw,
    to_human,
    to_raw,
)
from agentos.trading.prices import PriceInfo, PriceService, TokenMeta, native_token
from agentos.trading.providers import (
    PROVIDER_IDS,
    ProbeResult,
    ProviderBlockedError,
    ProviderError,
    ProviderQuote,
    SwapProvider,
    UniswapProvider,
    provider_label,
)
from agentos.trading.sync import WalletSyncer
from agentos.trading.uniswap import (
    DecisionOrigin,
    UniswapAuthError,
    UniswapClient,
    UniswapError,
    validate_transaction,
)
from agentos.trading.vault import Vault, VaultError, WalletNotFoundError, WalletRecord

log = structlog.get_logger(__name__)

Initiator = Literal["manual", "agent"]
Broadcast = Callable[[str, dict[str, Any]], Awaitable[None]]

RECEIPT_TIMEOUT_S = 180.0
# Pause between wallets in a batch so a multi-wallet swap stays under the
# Trading API's per-endpoint rate limit.
BATCH_PAUSE_S = 0.35
# WETH9 ``withdraw(uint256)``.
SEL_WETH_WITHDRAW = "0x2e1a7d4d"


def _origin(initiator: str) -> DecisionOrigin:
    return "autonomous" if initiator == "agent" else "human_mediated"


CHART_RANGES: dict[str, tuple[str, int, float]] = {
    # range -> (geckoterminal timeframe, limit, seconds back for snapshots)
    "1d": ("15m", 96, 86_400),
    "1w": ("hour", 168, 7 * 86_400),
    "1m": ("4h", 180, 30 * 86_400),
    "1y": ("day", 365, 365 * 86_400),
}


class TradingError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: Any | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


def _err(exc: Exception) -> TradingError:
    """Normalise every subsystem error into a coded TradingError."""
    if isinstance(exc, TradingError):
        return exc
    if isinstance(exc, VaultError):
        return TradingError(getattr(exc, "code", "wallet.error"), str(exc))
    if isinstance(exc, UniswapAuthError):
        return TradingError("trading.no_api_key", str(exc))
    if isinstance(exc, UniswapError):
        return TradingError(exc.code, str(exc), details={"errorCode": exc.error_code})
    if isinstance(exc, ProviderBlockedError):
        return TradingError(exc.code, str(exc), details={"provider": exc.provider, "blocked": True})
    if isinstance(exc, ProviderError):
        return TradingError(exc.code, str(exc), details=exc.details)
    if isinstance(exc, UnsupportedChainError):
        return TradingError("trading.unsupported_chain", str(exc))
    if isinstance(exc, EvmRpcError | EvmTransportError):
        return TradingError("trading.rpc", str(exc))
    if isinstance(exc, ValueError):
        return TradingError("trading.invalid", str(exc))
    return TradingError("trading.error", str(exc) or exc.__class__.__name__)


async def _default_broadcast(event: str, payload: dict[str, Any]) -> None:
    """No transport wired (tests, CLI-only use): events are logged, not sent."""
    log.debug("trading.event", event=event)


def _sign_tx(tx: dict[str, Any], key: bytes) -> str:
    from eth_account import Account

    signed = Account.sign_transaction(tx, key)
    return "0x" + bytes(signed.raw_transaction).hex()


def _sign_permit(permit: dict[str, Any], key: bytes) -> str:
    from eth_account import Account

    types = {k: v for k, v in dict(permit.get("types") or {}).items() if k != "EIP712Domain"}
    signed = Account.sign_typed_data(
        key,
        domain_data=dict(permit.get("domain") or {}),
        message_types=types,
        message_data=dict(permit.get("values") or {}),
    )
    return "0x" + bytes(signed.signature).hex()


class TradingService:
    def __init__(
        self,
        config: Any,
        *,
        vault: Vault | None = None,
        ledger: Ledger | None = None,
        prices: PriceService | None = None,
        http: httpx.AsyncClient | None = None,
        evm_factory: Callable[[ChainSpec], EvmClient] | None = None,
        uniswap_factory: Callable[[str], UniswapClient] | None = None,
        kyber_factory: Callable[[str], KyberClient] | None = None,
        broadcast: Broadcast | None = None,
        now: Callable[[], float] = time.time,
        sign_tx: Callable[[dict[str, Any], bytes], str] = _sign_tx,
        sign_permit: Callable[[dict[str, Any], bytes], str] = _sign_permit,
        background: bool = True,
    ) -> None:
        self._gateway_config = config
        self.config = getattr(config, "trading", config)
        self.vault = vault or Vault()
        self.ledger = ledger or Ledger()
        self._http = http or httpx.AsyncClient(timeout=15.0)
        self.prices = prices or PriceService(
            http=self._http, ttl_s=float(getattr(self.config, "price_ttl_seconds", 20))
        )
        self._evm_factory = evm_factory
        self._uniswap_factory = uniswap_factory
        self._kyber_factory = kyber_factory
        self._kyber: KyberClient | None = None
        self._kyber_client_id = ""
        self._broadcast = broadcast or _default_broadcast
        self._now = now
        self._sign_tx = sign_tx
        self._sign_permit = sign_permit
        self._background = background
        self._evm: dict[int, EvmClient] = {}
        self._uniswap: UniswapClient | None = None
        self._uniswap_key = ""
        self._task: asyncio.Task[None] | None = None
        self._confirm_tasks: set[asyncio.Task[Any]] = set()
        self._order_events: dict[str, asyncio.Event] = {}
        self._sync_lock = asyncio.Lock()
        self.syncing = False
        self.last_sync_at: float | None = None
        self.syncer = WalletSyncer(
            self.ledger,
            self.prices,
            evm_for=self.evm,
            token_meta=self.token_meta,
            watch_tokens=self.watch_tokens,
            now=now,
        )

    # ── infrastructure ─────────────────────────────────────────────────

    def chains(self) -> list[ChainSpec]:
        return list(CHAINS.values())

    def evm(self, chain: ChainSpec) -> EvmClient:
        client = self._evm.get(chain.chain_id)
        if client is None:
            if self._evm_factory is not None:
                client = self._evm_factory(chain)
            else:
                url = rpc_url_for(chain, dict(getattr(self.config, "rpc_urls", {}) or {}))
                client = EvmClient(url, http=self._http, max_log_span=chain.max_log_span)
            self._evm[chain.chain_id] = client
        return client

    def api_key(self) -> str:
        resolver = getattr(self.config, "resolved_uniswap_api_key", None)
        if callable(resolver):
            return str(resolver() or "")
        return str(getattr(self.config, "uniswap_api_key", "") or "")

    def uniswap(self, api_key: str | None = None) -> UniswapClient:
        key = api_key if api_key is not None else self.api_key()
        if not key:
            raise TradingError("trading.no_api_key", "No Uniswap API key configured")
        if api_key is not None and api_key != self.api_key():
            if self._uniswap_factory is not None:
                return self._uniswap_factory(key)
            return UniswapClient(key, http=self._http)
        if self._uniswap is None or self._uniswap_key != key:
            self._uniswap = (
                self._uniswap_factory(key)
                if self._uniswap_factory is not None
                else UniswapClient(key, http=self._http)
            )
            self._uniswap_key = key
        return self._uniswap

    def kyber(self) -> KyberClient:
        client_id = str(getattr(self.config, "kyber_client_id", "") or "agentos")
        if self._kyber is None or self._kyber_client_id != client_id:
            self._kyber = (
                self._kyber_factory(client_id)
                if self._kyber_factory is not None
                else KyberClient(client_id=client_id, http=self._http)
            )
            self._kyber_client_id = client_id
        return self._kyber

    def provider_id(self) -> str:
        value = str(getattr(self.config, "provider", "uniswap") or "uniswap").strip().lower()
        return value if value in PROVIDER_IDS else "uniswap"

    def provider(
        self, provider_id: str | None = None, *, api_key: str | None = None
    ) -> SwapProvider:
        """The swap provider to use for this call (read from config every time)."""
        chosen = (provider_id or "").strip().lower() or self.provider_id()
        if chosen == "uniswap":
            return UniswapProvider(self.uniswap(api_key))
        if chosen == "kyber":
            return KyberProvider(self.kyber())
        raise TradingError("trading.invalid", f"unknown swap provider {chosen!r}")

    def ensure_unlocked(self) -> bool:
        if self.vault.unlocked:
            return True
        return self.vault.try_auto_unlock()

    def ensure_started(self) -> None:
        """Start the sync/expiry loop once an event loop is running."""
        if not self._background or self._task is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._task = loop.create_task(self._run_loop(), name="trading-sync")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        for task in list(self._confirm_tasks):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._confirm_tasks.clear()

    async def aclose(self) -> None:
        await self.stop()
        for client in self._evm.values():
            await client.aclose()
        if self._uniswap is not None:
            await self._uniswap.aclose()
        await self.prices.aclose()
        await self._http.aclose()
        self.ledger.close()

    async def _run_loop(self) -> None:
        interval = float(getattr(self.config, "sync_interval_seconds", 30))
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - defensive
                log.warning("trading.loop_error", error=str(exc))
            await asyncio.sleep(interval)

    async def tick(self) -> None:
        """One pass of housekeeping: expire approvals, sync wallets."""
        await self.expire_orders()
        if self.vault.initialized:
            await self.sync_all()

    async def _emit(self, event: str, payload: dict[str, Any]) -> None:
        try:
            await self._broadcast(event, {"schema_version": 1, **payload})
        except Exception:  # pragma: no cover
            log.debug("trading.emit_failed", event=event)

    # ── status / probe ─────────────────────────────────────────────────

    async def status(self, *, check_rpc: bool = False) -> dict[str, Any]:
        chains = []
        for chain in self.chains():
            healthy: bool | None = None
            if check_rpc:
                try:
                    healthy = (await self.evm(chain).chain_id()) == chain.chain_id
                except Exception:
                    healthy = False
            row = chain.to_dict()
            # Provider keys live in the URL path (dRPC, Alchemy, Infura): never send
            # them to a client.
            row["rpcUrl"] = redact_rpc_url(
                rpc_url_for(chain, dict(getattr(self.config, "rpc_urls", {}) or {}))
            )
            row["healthy"] = healthy
            chains.append(row)
        vault = self.vault.status()
        providers = []
        for pid in PROVIDER_IDS:
            needs_key = pid == "uniswap"
            prow: dict[str, Any] = {
                "id": pid,
                "label": provider_label(pid),
                "needsKey": needs_key,
                "keyConfigured": bool(self.api_key()) if needs_key else True,
                "blocked": None,
                "healthy": None,
                "active": pid == self.provider_id(),
            }
            if check_rpc:
                try:
                    result = await self.provider(pid).probe(chain=self.chains()[0])
                except TradingError:
                    result = ProbeResult(ok=False, latency_ms=None, error="not configured")
                prow["blocked"] = result.blocked
                prow["healthy"] = result.ok
            providers.append(prow)
        return {
            "enabled": bool(getattr(self.config, "enabled", True)),
            "version": __version__,
            "provider": self.provider_id(),
            "providers": providers,
            "apiKeyConfigured": bool(self.api_key()),
            "chains": chains,
            "limits": self._limits_dict(),
            "unlockMode": vault["unlockMode"],
            "unlocked": vault["unlocked"],
            "initialized": vault["initialized"],
            "walletCount": vault["walletCount"],
            "syncing": self.syncing,
            "lastSyncAt": int(self.last_sync_at * 1000) if self.last_sync_at else None,
        }

    def _limits_dict(self) -> dict[str, Any]:
        return {
            "approvalThresholdUsd": float(getattr(self.config, "approval_threshold_usd", 100.0)),
            "dailyCapUsd": float(getattr(self.config, "daily_cap_usd", 1000.0)),
            "approvalTtlSeconds": int(getattr(self.config, "approval_ttl_seconds", 900)),
        }

    async def probe(
        self, api_key: str | None = None, *, provider_id: str | None = None
    ) -> dict[str, Any]:
        chosen = (provider_id or "").strip().lower() or self.provider_id()
        if chosen not in PROVIDER_IDS:
            raise TradingError("trading.invalid", f"unknown swap provider {chosen!r}")
        if chosen == "uniswap":
            key = (api_key or "").strip() or self.api_key()
            if not key:
                return {
                    "provider": chosen,
                    "ok": False,
                    "latencyMs": None,
                    "error": "No Uniswap API key configured",
                    "blocked": False,
                }
            result = await self.provider("uniswap", api_key=key).probe(chain=self.chains()[0])
        else:
            result = await self.provider(chosen).probe(chain=self.chains()[0])
        return {"provider": chosen, **result.to_dict()}

    # ── tokens ─────────────────────────────────────────────────────────

    async def token_meta(self, chain: ChainSpec, address: str) -> TokenMeta:
        if is_native(address):
            meta = native_token(chain)
            self._remember_token(meta)
            return meta
        key = normalize_address(address)
        row = self.ledger.get_token(chain.chain_id, key)
        if row and (row["symbol"] or row["verified"]):
            return TokenMeta(
                chain_id=chain.chain_id,
                address=key,
                symbol=str(row["symbol"]),
                name=str(row["name"]),
                decimals=int(row["decimals"]),
                logo_url=row["logo_url"],
                verified=bool(row["verified"]),
                stock_token=str(row["name"]).endswith("• Robinhood Token"),
            )
        known = await self.prices.known_token(chain, key)
        if known is not None:
            self._remember_token(known)
            return known
        symbol, name, decimals = "", "", 18
        try:
            symbol, name, decimals = await self.evm(chain).erc20_metadata(key)
        except (EvmRpcError, EvmTransportError):
            pass
        meta = TokenMeta(chain.chain_id, key, symbol, name, decimals)
        self._remember_token(meta)
        return meta

    def _remember_token(self, meta: TokenMeta) -> None:
        self.ledger.upsert_token(
            meta.chain_id,
            meta.address,
            symbol=meta.symbol,
            name=meta.name,
            decimals=meta.decimals,
            logo_url=meta.logo_url,
            is_native=meta.native,
            verified=meta.verified,
        )

    async def resolve_token(self, chain: ChainSpec, value: str) -> TokenMeta:
        """An address, ``ETH``, or a symbol (unique, verified) → metadata."""
        text = (value or "").strip()
        if not text:
            raise TradingError("trading.invalid", "token is required")
        if is_native(text) or text.lower() == chain.native_symbol.lower():
            return await self.token_meta(chain, NATIVE_ADDRESS)
        if text.startswith("0x"):
            return await self.token_meta(chain, text)
        hits = await self.prices.find_by_symbol(chain, text)
        if not hits:
            raise TradingError("trading.invalid", f"Unknown token symbol {text!r} on {chain.name}")
        stock = [h for h in hits if h.stock_token]
        chosen = stock[0] if len(stock) == 1 else (hits[0] if len(hits) == 1 else None)
        if chosen is None:
            raise TradingError(
                "trading.invalid",
                f"Symbol {text!r} is ambiguous on {chain.name}; pass the address",
                details={"candidates": [h.to_dict() for h in hits[:5]]},
            )
        return await self.token_meta(chain, chosen.address)

    async def search_tokens(self, chain: ChainSpec, query: str) -> list[dict[str, Any]]:
        rows = await self.prices.search(chain, query)
        for row in rows:
            self.ledger.upsert_token(
                chain.chain_id,
                str(row["address"]),
                symbol=str(row.get("symbol") or ""),
                name=str(row.get("name") or ""),
                decimals=int(row.get("decimals") or 18),
                logo_url=row.get("logoUrl"),
                is_native=bool(row.get("native")),
                verified=bool(row.get("verified")),
            )
        return rows

    def _token_dict(self, chain_id: int, address: str | None) -> dict[str, Any] | None:
        if address is None:
            return None
        chain = CHAINS.get(chain_id)
        if is_native(address) and chain is not None:
            return native_token(chain).to_dict()
        row = self.ledger.get_token(chain_id, address)
        if row is None:
            return TokenMeta(chain_id, address.lower(), "", "", 18).to_dict()
        return TokenMeta(
            chain_id=chain_id,
            address=str(row["address"]),
            symbol=str(row["symbol"]),
            name=str(row["name"]),
            decimals=int(row["decimals"]),
            logo_url=row["logo_url"],
            native=bool(row["is_native"]),
            verified=bool(row["verified"]),
            stock_token=str(row["name"]).endswith("• Robinhood Token"),
        ).to_dict()

    def _decimals(self, chain_id: int, address: str) -> int:
        if is_native(address):
            return 18
        row = self.ledger.get_token(chain_id, address)
        return int(row["decimals"]) if row else 18

    async def watch_tokens(self, chain: ChainSpec) -> list[str]:
        """Tokens every wallet is scanned for: the chain's USDC/WETH plus any token
        the ledger has met (searched, traded, or transferred)."""
        tokens: set[str] = set()
        weth = await self.weth_for(chain)
        if weth:
            tokens.add(weth)
        usdc = await self.usdc_for(chain)
        if usdc:
            tokens.add(usdc)
        for row in self.ledger.tokens(chain.chain_id):
            if not row["is_native"]:
                tokens.add(str(row["address"]))
        return sorted(tokens)

    async def usdc_for(self, chain: ChainSpec) -> str | None:
        if chain.usdc:
            return chain.usdc.lower()
        hits = await self.prices.find_by_symbol(chain, "USDC")
        return hits[0].address if hits else None

    async def weth_for(self, chain: ChainSpec) -> str | None:
        """The wrapped native token on ``chain`` (lowercase), if known."""
        if chain.weth:
            return chain.weth.lower()
        hits = await self.prices.find_by_symbol(chain, "WETH")
        return hits[0].address if hits else None

    async def unwrap(
        self, chain: ChainSpec, wallet: str | None, amount: str | None = None
    ) -> dict[str, Any]:
        """Send ``WETH.withdraw(amount)`` from ``wallet``; whole balance when omitted."""
        if not self.ensure_unlocked():
            raise TradingError("wallet.locked", "Wallet vault is locked")
        record = self.vault.resolve(wallet)
        weth = await self.weth_for(chain)
        if weth is None:
            raise TradingError("trading.invalid", f"WETH is not known on {chain.name}")
        meta = await self.token_meta(chain, weth)
        evm = self.evm(chain)
        balance = await evm.erc20_balance_of(weth, record.address)
        raw = to_raw(amount, meta.decimals) if amount else balance
        if raw <= 0:
            raise TradingError("trading.invalid", "nothing to unwrap")
        if raw > balance:
            raise TradingError(
                "trading.insufficient_balance",
                f"{record.label} holds {format_amount(balance, meta.decimals)} WETH",
            )
        key = self.vault.private_key(record.address)
        tx = {
            "to": checksum_address(weth),
            "from": record.address,
            "data": SEL_WETH_WITHDRAW + pad_uint(raw),
            "value": "0",
            "chainId": chain.chain_id,
        }
        tx_hash = await self._send(chain, record, key, tx)
        receipt = await evm.wait_for_receipt(tx_hash, timeout_s=RECEIPT_TIMEOUT_S)
        if not receipt_succeeded(receipt):
            raise TradingError("trading.tx_failed", f"unwrap transaction failed ({tx_hash})")
        gas_wei = receipt_gas_wei(receipt or {})
        eth_price = await self.prices.price(chain, NATIVE_ADDRESS)
        gas_usd = float(to_human(gas_wei, 18)) * eth_price if eth_price is not None else None
        entry_id = self.ledger.insert_entry(
            ts=self._now(),
            chain_id=chain.chain_id,
            wallet=record.key,
            kind="unwrap",
            tx_hash=tx_hash,
            log_index=0,
            token_in=weth,
            amount_in_raw=raw,
            token_out=NATIVE_ADDRESS,
            amount_out_raw=raw,
            gas_usd=gas_usd,
            initiator="manual",
        )
        # Move the lots across 1:1 so cost basis follows the ETH.
        lots = self.ledger.open_lots(chain.chain_id, record.key, weth)
        moved = 0
        for lot in lots:
            if moved >= raw:
                break
            take = min(lot.amount_raw, raw - moved)
            self.ledger.add_lot(
                chain.chain_id,
                record.key,
                NATIVE_ADDRESS,
                amount_raw=take,
                cost_usd_per_raw=lot.cost_usd_per_raw,
                acquired_at=lot.acquired_at,
                entry_id=entry_id,
            )
            lot.amount_raw -= take
            moved += take
        self.ledger.save_lots(lots)
        self.ledger.set_balance(chain.chain_id, record.key, weth, balance - raw)
        self.ledger.set_balance(
            chain.chain_id, record.key, NATIVE_ADDRESS, await evm.get_balance(record.address)
        )
        await self._emit("trading.changed", {"reason": "sync", "wallet": record.address})
        return {
            "txHash": tx_hash,
            "explorerUrl": chain.tx_url(tx_hash),
            "amount": format_amount(raw, 18),
        }

    # ── wallets ────────────────────────────────────────────────────────

    def wallet_dicts(self) -> list[dict[str, Any]]:
        if not self.vault.initialized:
            return []
        primary = self.vault.primary_address()
        rows = []
        for record in self.vault.list():
            row = record.to_dict(primary=(record.address == primary))
            row["chains"] = [c.chain_id for c in self.chains()]
            rows.append(row)
        return rows

    def _mirror_wallet(self, record: WalletRecord) -> None:
        primary = self.vault.primary_address()
        self.ledger.upsert_wallet(
            record.key,
            label=record.label,
            is_primary=(record.address == primary),
            created_at=record.created_at,
            created_block=record.created_block,
        )

    async def create_wallet(self, label: str) -> dict[str, Any]:
        self.ensure_unlocked()
        record = self.vault.create(label)
        await self._stamp_created_block(record)
        self._mirror_wallet(record)
        await self._emit("trading.changed", {"reason": "wallet", "wallet": record.address})
        return record.to_dict(primary=(self.vault.primary_address() == record.address))

    async def _stamp_created_block(self, record: WalletRecord) -> None:
        for chain in self.chains():
            try:
                block = await self.evm(chain).block_number()
            except Exception:
                continue
            self.vault.set_created_block(record.address, chain.chain_id, block)
            record.created_block[str(chain.chain_id)] = block

    async def import_wallet(
        self,
        label: str,
        *,
        private_key: str | None = None,
        keystore_json: str | None = None,
        keystore_password: str | None = None,
    ) -> dict[str, Any]:
        self.ensure_unlocked()
        if private_key:
            record = self.vault.import_private_key(label, private_key)
        elif keystore_json:
            record = self.vault.import_keystore(label, keystore_json, keystore_password or "")
        else:
            raise TradingError("trading.invalid", "privateKey or keystoreJson is required")
        self._mirror_wallet(record)
        await self._emit("trading.changed", {"reason": "wallet", "wallet": record.address})
        return record.to_dict(primary=(self.vault.primary_address() == record.address))

    async def remove_wallet(self, address: str, password: str) -> None:
        record = self.vault.get(address)
        self.vault.remove(record.address, password)
        self.ledger.remove_wallet(record.key)
        await self._emit("trading.changed", {"reason": "wallet", "wallet": record.address})

    def _wallets_for(self, selector: Any) -> list[WalletRecord]:
        if selector in (None, "", "primary"):
            return [self.vault.resolve(None)]
        if selector == "all":
            return self.vault.list()
        if isinstance(selector, str):
            return [self.vault.resolve(selector)]
        if isinstance(selector, list):
            out: list[WalletRecord] = []
            seen: set[str] = set()
            for item in selector:
                record = self.vault.resolve(str(item))
                if record.key not in seen:
                    seen.add(record.key)
                    out.append(record)
            if not out:
                raise WalletNotFoundError("no wallets selected")
            return out
        raise TradingError("trading.invalid", "wallets must be an address list, 'all' or omitted")

    # ── balances / portfolio ───────────────────────────────────────────

    async def balances(
        self, wallet: str | None = None, chain_id: int | None = None, *, refresh: bool = True
    ) -> list[dict[str, Any]]:
        records = self.vault.list() if wallet is None else [self.vault.resolve(wallet)]
        chains = [c for c in self.chains() if chain_id is None or c.chain_id == chain_id]
        rows: list[dict[str, Any]] = []
        for chain in chains:
            wanted: dict[str, dict[str, Any]] = {}
            for record in records:
                if refresh:
                    evm = self.evm(chain)
                    try:
                        await self.syncer.ensure_opening(record, chain, NATIVE_ADDRESS, evm)
                        native = await evm.get_balance(record.address)
                        self.ledger.set_balance(chain.chain_id, record.key, NATIVE_ADDRESS, native)
                        await self.syncer._refresh_balances(record, chain, evm)
                    except (EvmRpcError, EvmTransportError) as exc:
                        log.warning(
                            "trading.balance_refresh_failed", chain=chain.key, error=str(exc)
                        )
                for row in self.ledger.balances(record.key, chain.chain_id):
                    raw = int(row["raw"])
                    if raw <= 0 and row["token"] != NATIVE_ADDRESS:
                        continue
                    key = f"{row['wallet']}:{row['token']}"
                    wanted[key] = {
                        "wallet": checksum_address(row["wallet"]),
                        "token": row["token"],
                        "raw": raw,
                    }
            if not wanted:
                continue
            addresses = sorted({w["token"] for w in wanted.values()})
            for address in addresses:
                await self.token_meta(chain, address)
            prices = await self.prices.prices(chain, addresses)
            for item in wanted.values():
                token_info = self._token_dict(chain.chain_id, item["token"]) or {}
                decimals = int(token_info.get("decimals", 18))
                price_info = prices.get(item["token"])
                amount = float(to_human(item["raw"], decimals))
                price = price_info.price_usd if price_info else None
                rows.append(
                    {
                        "chainId": chain.chain_id,
                        "wallet": item["wallet"],
                        "token": token_info,
                        "raw": str(item["raw"]),
                        "amount": format_amount(item["raw"], decimals),
                        "priceUsd": price,
                        "valueUsd": amount * price if price is not None else None,
                        "change24hPct": price_info.change_24h_pct if price_info else None,
                    }
                )
        rows.sort(key=lambda r: -(r["valueUsd"] or 0.0))
        return rows

    async def portfolio(self, wallet: str | None = None) -> dict[str, Any]:
        records = self.vault.list() if wallet is None else [self.vault.resolve(wallet)]
        keys = {r.key for r in records}
        positions = [p for p in self.ledger.positions(None if wallet is None else records[0].key)]
        realized = self.ledger.realized_by_position(None if wallet is None else records[0].key)
        # Balance rows are the on-chain truth for the amount; lots supply cost.
        holdings_keys: set[tuple[int, str, str]] = set()
        for pos in positions:
            if pos.wallet in keys:
                holdings_keys.add((pos.chain_id, pos.wallet, pos.token))
        for row in self.ledger.balances(None if wallet is None else records[0].key):
            if row["wallet"] in keys and int(row["raw"]) > 0:
                holdings_keys.add((int(row["chain_id"]), str(row["wallet"]), str(row["token"])))
        by_chain: dict[int, set[str]] = {}
        for chain_id, _wallet, token in holdings_keys:
            by_chain.setdefault(chain_id, set()).add(token)
        price_map: dict[tuple[int, str], PriceInfo] = {}
        for chain_id, tokens in by_chain.items():
            chain = CHAINS[chain_id]
            for token in tokens:
                await self.token_meta(chain, token)
            for token, info in (await self.prices.prices(chain, sorted(tokens))).items():
                price_map[(chain_id, token)] = info
        pos_by_key = {(p.chain_id, p.wallet, p.token): p for p in positions}
        holdings: list[dict[str, Any]] = []
        per_wallet: dict[str, dict[str, float]] = {
            r.key: {"value": 0.0, "cost": 0.0, "realized": 0.0, "change": 0.0} for r in records
        }
        for chain_id, wallet_key, token in sorted(holdings_keys):
            decimals = self._decimals(chain_id, token)
            balance_raw = self.ledger.get_balance(chain_id, wallet_key, token)
            position = pos_by_key.get((chain_id, wallet_key, token))
            amount_raw = (
                balance_raw if balance_raw is not None else (position.amount_raw if position else 0)
            )
            if amount_raw <= 0 and (position is None or position.amount_raw <= 0):
                continue
            cost = position.cost_usd if position else 0.0
            if position and position.amount_raw > 0 and amount_raw < position.amount_raw:
                cost = cost * (amount_raw / position.amount_raw)
            price_info = price_map.get((chain_id, token))
            price = price_info.price_usd if price_info else None
            pnl = holding_from_lots(
                [],
                decimals=decimals,
                price_usd=price,
                realized_usd=realized.get((chain_id, wallet_key, token), 0.0),
            )
            pnl.amount_raw = amount_raw
            pnl.cost_usd = cost
            value = pnl.value_usd
            change_pct = price_info.change_24h_pct if price_info else None
            change_usd = (
                value - value / (1 + change_pct / 100.0)
                if value is not None and change_pct is not None and change_pct > -100
                else None
            )
            holdings.append(
                {
                    "chainId": chain_id,
                    "wallet": checksum_address(wallet_key),
                    "token": self._token_dict(chain_id, token),
                    "amount": format_amount(amount_raw, decimals),
                    "raw": str(amount_raw),
                    "priceUsd": price,
                    "valueUsd": value,
                    "costUsd": cost if cost > 0 else None,
                    "avgCostUsd": pnl.avg_cost_usd,
                    "unrealizedUsd": pnl.unrealized_usd,
                    "unrealizedPct": pnl.unrealized_pct,
                    "realizedUsd": pnl.realized_usd,
                    "change24hPct": change_pct,
                    "change24hUsd": change_usd,
                    "allocationPct": 0.0,
                }
            )
            bucket = per_wallet.setdefault(
                wallet_key, {"value": 0.0, "cost": 0.0, "realized": 0.0, "change": 0.0}
            )
            bucket["value"] += value or 0.0
            bucket["cost"] += cost
            bucket["realized"] += pnl.realized_usd
            bucket["change"] += change_usd or 0.0
        total_value = sum(h["valueUsd"] or 0.0 for h in holdings)
        for h in holdings:
            h["allocationPct"] = (
                (h["valueUsd"] or 0.0) / total_value * 100.0 if total_value > 0 else 0.0
            )
        holdings.sort(key=lambda h: -(h["valueUsd"] or 0.0))
        gas_total = self.ledger.gas_total(None if wallet is None else records[0].key)
        wallets_out = []
        primary = self.vault.primary_address()
        for record in records:
            bucket = per_wallet[record.key]
            wallets_out.append(
                {
                    "wallet": {
                        **record.to_dict(primary=(record.address == primary)),
                        "chains": [c.chain_id for c in self.chains()],
                    },
                    "totals": self._totals(
                        bucket["value"],
                        bucket["cost"],
                        bucket["realized"],
                        self.ledger.gas_total(record.key),
                        bucket["change"],
                    ),
                }
            )
        totals = self._totals(
            total_value,
            sum(b["cost"] for b in per_wallet.values()),
            sum(b["realized"] for b in per_wallet.values()),
            gas_total,
            sum(b["change"] for b in per_wallet.values()),
        )
        return {
            "totals": totals,
            "holdings": holdings,
            "wallets": wallets_out,
            "updatedAt": int(self._now() * 1000),
            "syncing": self.syncing,
        }

    @staticmethod
    def _totals(
        value: float, cost: float, realized: float, gas: float, change: float
    ) -> dict[str, Any]:
        previous = value - change
        return {
            "valueUsd": value,
            "costUsd": cost,
            "unrealizedUsd": (value - cost) if cost > 0 else 0.0,
            "realizedUsd": realized,
            "gasUsd": gas,
            "change24hUsd": change,
            "change24hPct": (change / previous * 100.0) if previous > 0 else None,
        }

    # ── history / chart / limits ───────────────────────────────────────

    def _entry_dict(self, row: dict[str, Any]) -> dict[str, Any]:
        chain_id = int(row["chain_id"])
        chain = CHAINS.get(chain_id)
        tx_hash = row.get("tx_hash")
        token_in = self._token_dict(chain_id, row.get("token_in"))
        token_out = self._token_dict(chain_id, row.get("token_out"))
        amount_in = row.get("amount_in_raw")
        amount_out = row.get("amount_out_raw")
        return {
            "id": int(row["id"]),
            "ts": int(float(row["ts"]) * 1000),
            "chainId": chain_id,
            "wallet": checksum_address(str(row["wallet"])),
            "kind": row["kind"],
            "txHash": tx_hash,
            "explorerUrl": chain.tx_url(tx_hash) if chain and tx_hash else None,
            "tokenIn": token_in,
            "amountIn": (
                format_amount(int(amount_in), int(token_in["decimals"]))
                if amount_in is not None and token_in
                else None
            ),
            "tokenOut": token_out,
            "amountOut": (
                format_amount(int(amount_out), int(token_out["decimals"]))
                if amount_out is not None and token_out
                else None
            ),
            "valueUsd": row.get("value_usd"),
            "gasUsd": row.get("gas_usd"),
            "priceInUsd": row.get("price_in_usd"),
            "priceOutUsd": row.get("price_out_usd"),
            "costBasisSource": row.get("cost_basis_source"),
            "initiator": row.get("initiator") or "external",
            "orderId": row.get("order_id"),
            "sessionKey": row.get("session_key"),
            "note": row.get("note"),
        }

    def history(
        self,
        *,
        wallet: str | None = None,
        chain_id: int | None = None,
        kind: str | None = None,
        limit: int = 100,
        before: float | None = None,
    ) -> dict[str, Any]:
        key = self.vault.resolve(wallet).key if wallet else None
        rows = self.ledger.list_entries(
            wallet=key, chain_id=chain_id, kind=kind, limit=limit, before=before
        )
        entries = [self._entry_dict(r) for r in rows]
        next_before = float(rows[-1]["ts"]) if len(rows) >= max(1, min(limit, 1000)) else None
        return {"entries": entries, "nextBefore": next_before}

    async def chart(self, chain: ChainSpec, token: str, range_key: str) -> dict[str, Any]:
        timeframe, limit, seconds = CHART_RANGES.get(range_key, CHART_RANGES["1w"])
        address = NATIVE_ADDRESS if is_native(token) else normalize_address(token)
        candles = await self.prices.ohlcv(chain, address, timeframe=timeframe, limit=limit)
        if candles:
            return {"source": "geckoterminal", "range": range_key, "points": candles}
        since = self._now() - seconds
        snaps = self.ledger.snapshots(chain.chain_id, address, since)
        return {
            "source": "snapshots",
            "range": range_key,
            "points": [{"t": float(s["ts"]), "c": float(s["price_usd"])} for s in snaps],
        }

    def limits(self, wallet: str | None) -> dict[str, Any]:
        record = self.vault.resolve(wallet)
        return {
            **self._limits_dict(),
            "wallet": record.address,
            "spentTodayUsd": round(self.ledger.spent_today(record.key), 2),
            "day": local_day(self._now()),
        }

    def set_lot_cost(self, entry_id: int, cost_usd_per_token: float) -> dict[str, Any]:
        entry = self.ledger.get_entry(entry_id)
        if entry is None:
            raise TradingError("trading.invalid", f"no history entry {entry_id}")
        lots = self.ledger.lots_for_entry(entry_id)
        if not lots:
            raise TradingError("trading.invalid", "entry has no lot to reprice")
        token = str(lots[0]["token"])
        decimals = self._decimals(int(entry["chain_id"]), token)
        for lot in lots:
            self.ledger.update_lot_cost(int(lot["id"]), per_raw(cost_usd_per_token, decimals))
        amount_raw = entry.get("amount_out_raw")
        value = (
            float(to_human(int(amount_raw), decimals)) * float(cost_usd_per_token)
            if amount_raw is not None
            else entry.get("value_usd")
        )
        self.ledger.update_entry(
            entry_id,
            value_usd=value,
            price_out_usd=float(cost_usd_per_token),
            cost_basis_source="manual",
        )
        refreshed = self.ledger.get_entry(entry_id)
        assert refreshed is not None
        return self._entry_dict(refreshed)

    # ── sync ───────────────────────────────────────────────────────────

    async def sync_all(self, *, wallet: str | None = None, full: bool = False) -> int:
        if self._sync_lock.locked():
            return 0
        async with self._sync_lock:
            self.syncing = True
            changed = 0
            try:
                records = self.vault.list() if wallet is None else [self.vault.resolve(wallet)]
                for record in records:
                    for chain in self.chains():
                        try:
                            if await self.syncer.sync(record, chain, full=full):
                                changed += 1
                                await self._emit(
                                    "trading.changed", {"reason": "sync", "wallet": record.address}
                                )
                        except (EvmRpcError, EvmTransportError, httpx.HTTPError) as exc:
                            log.warning(
                                "trading.sync_failed",
                                chain=chain.key,
                                wallet=record.address,
                                error=str(exc),
                            )
                self.last_sync_at = self._now()
            finally:
                self.syncing = False
            return changed

    def request_sync(self, *, wallet: str | None = None, full: bool = False) -> None:
        loop = asyncio.get_running_loop()
        task = loop.create_task(self.sync_all(wallet=wallet, full=full), name="trading-sync-once")
        self._confirm_tasks.add(task)
        task.add_done_callback(self._confirm_tasks.discard)

    # ── quotes ─────────────────────────────────────────────────────────

    async def _value_usd(self, chain: ChainSpec, token: TokenMeta, amount_raw: int) -> float | None:
        price = await self.prices.price(chain, token.address)
        if price is None:
            return None
        return float(to_human(amount_raw, token.decimals)) * price

    async def quote(
        self,
        *,
        chain: ChainSpec,
        wallet: str | None,
        token_in: str,
        token_out: str,
        amount_in: str,
        slippage_pct: float | None = None,
        initiator: Initiator = "manual",
    ) -> dict[str, Any]:
        record = self.vault.resolve(wallet)
        meta_in = await self.resolve_token(chain, token_in)
        meta_out = await self.resolve_token(chain, token_out)
        amount_raw = to_raw(amount_in, meta_in.decimals)
        if amount_raw <= 0:
            raise TradingError("trading.invalid", "amountIn must be greater than zero")
        slippage = slippage_pct if slippage_pct is not None else self.config.default_slippage_pct
        try:
            quote = await self.provider().quote(
                chain=chain,
                swapper=record.address,
                token_in=meta_in.address if not meta_in.native else NATIVE_ADDRESS,
                token_out=meta_out.address if not meta_out.native else NATIVE_ADDRESS,
                amount_raw=amount_raw,
                slippage_pct=slippage,
                decision_origin=_origin(initiator),
            )
        except ProviderError as exc:
            raise _err(exc) from exc
        value = await self._value_usd(chain, meta_in, amount_raw)
        if value is None:
            value = await self._value_usd(chain, meta_out, quote.amount_out_raw)
        verdict = guardrails.evaluate(
            initiator=initiator,
            value_usd=value,
            threshold_usd=self.config.approval_threshold_usd,
            daily_cap_usd=self.config.daily_cap_usd,
            spent_today_usd=self.ledger.spent_today(record.key),
        )
        return self._quote_dict(chain, record, meta_in, meta_out, quote, value, verdict)

    def _quote_dict(
        self,
        chain: ChainSpec,
        record: WalletRecord,
        meta_in: TokenMeta,
        meta_out: TokenMeta,
        quote: ProviderQuote,
        value: float | None,
        verdict: guardrails.GuardVerdict,
    ) -> dict[str, Any]:
        human_in = to_human(quote.amount_in_raw, meta_in.decimals)
        human_out = to_human(quote.amount_out_raw, meta_out.decimals)
        rate = float(human_out / human_in) if human_in > 0 else None
        return {
            "quoteId": quote.quote_id,
            "provider": quote.provider,
            "providerLabel": provider_label(quote.provider),
            "routing": quote.routing,
            "warnings": list(quote.warnings),
            "chainId": chain.chain_id,
            "wallet": record.address,
            "tokenIn": meta_in.to_dict(),
            "tokenOut": meta_out.to_dict(),
            "amountIn": format_amount(quote.amount_in_raw, meta_in.decimals),
            "amountInRaw": str(quote.amount_in_raw),
            "amountOut": format_amount(quote.amount_out_raw, meta_out.decimals),
            "amountOutRaw": str(quote.amount_out_raw),
            "minOut": format_amount(quote.min_out_raw, meta_out.decimals),
            "priceImpactPct": quote.price_impact_pct,
            "gasUsd": quote.gas_usd,
            "valueUsd": value,
            "rate": rate,
            "slippagePct": quote.slippage_pct,
            "expiresAt": int((quote.fetched_at + quote.fresh_for_s) * 1000),
            "guard": verdict.to_dict(),
        }

    # ── swaps ──────────────────────────────────────────────────────────

    def _order_dict(self, row: dict[str, Any]) -> dict[str, Any]:
        chain_id = int(row["chain_id"])
        chain = CHAINS.get(chain_id)
        token_in = self._token_dict(chain_id, row["token_in"]) or {}
        token_out = self._token_dict(chain_id, row["token_out"]) or {}
        dec_out = int(token_out.get("decimals", 18))
        tx_hash = row.get("tx_hash")
        expected = row.get("expected_out_raw")
        min_out = row.get("min_out_raw")
        received = row.get("received_out_raw")
        return {
            "orderId": row["order_id"],
            "createdAt": int(float(row["created_at"]) * 1000),
            "updatedAt": int(float(row["updated_at"]) * 1000),
            "chainId": chain_id,
            "wallet": checksum_address(str(row["wallet"])),
            "tokenIn": token_in,
            "tokenOut": token_out,
            "amountIn": row["amount_human"],
            "amountInRaw": row["amount_raw"],
            "expectedOut": format_amount(int(expected), dec_out) if expected else None,
            "minOut": format_amount(int(min_out), dec_out) if min_out else None,
            "receivedOut": format_amount(int(received), dec_out) if received else None,
            "valueUsd": row.get("value_usd"),
            "priceImpactPct": row.get("price_impact_pct"),
            "gasUsd": row.get("gas_usd"),
            "slippagePct": row.get("slippage_pct"),
            "status": row["status"],
            "reason": row.get("reason"),
            "initiator": row["initiator"],
            "sessionKey": row.get("session_key"),
            "note": row.get("note"),
            "txHash": tx_hash,
            "approvalTxHash": row.get("approval_tx_hash"),
            "explorerUrl": chain.tx_url(tx_hash) if chain and tx_hash else None,
            "expiresAt": int(float(row["expires_at"]) * 1000) if row.get("expires_at") else None,
            "deliveredToken": self._token_dict(chain_id, row.get("delivered_token")),
            "provider": row.get("provider") or "uniswap",
            "providerLabel": provider_label(row.get("provider") or "uniswap"),
        }

    def get_order(self, order_id: str) -> dict[str, Any]:
        row = self.ledger.get_order(order_id)
        if row is None:
            raise TradingError("trading.invalid", f"no order {order_id}")
        return self._order_dict(row)

    def list_orders(
        self, *, status: str | None = None, wallet: str | None = None, limit: int = 50
    ) -> dict[str, Any]:
        key = self.vault.resolve(wallet).key if wallet else None
        rows = self.ledger.list_orders(status=status, wallet=key, limit=limit)
        return {
            "orders": [self._order_dict(r) for r in rows],
            "pendingApprovals": self.ledger.count_orders("awaiting_approval"),
        }

    async def swap(
        self,
        *,
        chain: ChainSpec,
        wallets: Any,
        token_in: str,
        token_out: str,
        amount_in: str | None,
        amount_pct: float | None,
        slippage_pct: float | None,
        initiator: Initiator,
        session_key: str | None,
        note: str | None,
        wait: bool = False,
    ) -> list[dict[str, Any]]:
        if not getattr(self.config, "enabled", True):
            raise TradingError("trading.disabled", "Trading is disabled in config")
        if initiator not in ("manual", "agent"):
            raise TradingError("trading.invalid", "initiator must be 'manual' or 'agent'")
        if not self.ensure_unlocked():
            raise TradingError("wallet.locked", "Wallet vault is locked")
        self.provider()  # raises early when the provider is not usable (no key)
        records = self._wallets_for(wallets)
        meta_in = await self.resolve_token(chain, token_in)
        meta_out = await self.resolve_token(chain, token_out)
        if meta_in.address == meta_out.address:
            raise TradingError("trading.invalid", "tokenIn and tokenOut are the same token")
        if amount_in is None and amount_pct is None:
            raise TradingError("trading.invalid", "amountIn or amountPct is required")
        if amount_pct is not None and not (0 < float(amount_pct) <= 100):
            raise TradingError("trading.invalid", "amountPct must be between 0 and 100")
        slippage = slippage_pct if slippage_pct is not None else self.config.default_slippage_pct
        results: list[dict[str, Any]] = []
        for index, record in enumerate(records):
            if index and BATCH_PAUSE_S > 0:
                await asyncio.sleep(BATCH_PAUSE_S)
            order_id = new_order_id()
            try:
                amount_raw = await self._amount_for(chain, record, meta_in, amount_in, amount_pct)
                row = self._new_order(
                    order_id,
                    chain,
                    record,
                    meta_in,
                    meta_out,
                    amount_raw,
                    slippage,
                    initiator,
                    session_key,
                    note,
                )
                await self._process_order(row, wait=wait)
            except Exception as exc:  # one wallet failing never blocks the batch
                error = _err(exc)
                if self.ledger.get_order(order_id) is None:
                    self.ledger.insert_order(
                        {
                            "order_id": order_id,
                            "created_at": self._now(),
                            "updated_at": self._now(),
                            "chain_id": chain.chain_id,
                            "wallet": record.key,
                            "token_in": meta_in.address,
                            "token_out": meta_out.address,
                            "amount_raw": "0",
                            "amount_human": amount_in or "0",
                            "status": "failed",
                            "reason": f"{error.code}: {error}",
                            "initiator": initiator,
                            "session_key": session_key,
                            "note": note,
                            "slippage_pct": slippage,
                        }
                    )
                else:
                    self.ledger.update_order(
                        order_id, status="failed", reason=f"{error.code}: {error}"
                    )
                log.warning("trading.order_failed", order=order_id, error=str(error))
                await self._emit("trading.order.finished", {"order": self.get_order(order_id)})
            results.append(self.get_order(order_id))
            await self._emit("trading.changed", {"reason": "order", "orderId": order_id})
        return results

    async def _amount_for(
        self,
        chain: ChainSpec,
        record: WalletRecord,
        meta_in: TokenMeta,
        amount_in: str | None,
        amount_pct: float | None,
    ) -> int:
        if amount_in is not None:
            raw = to_raw(amount_in, meta_in.decimals)
        else:
            balance = await self._balance_raw(chain, record, meta_in)
            if meta_in.native and float(amount_pct or 0) >= 100:
                # Keep a gas reserve when spending the whole native balance.
                balance = max(0, balance - 10**15)
            raw = balance * int(float(amount_pct or 0) * 100) // 10_000
        if raw <= 0:
            raise TradingError("trading.invalid", "amount must be greater than zero")
        return raw

    async def _balance_raw(self, chain: ChainSpec, record: WalletRecord, meta: TokenMeta) -> int:
        evm = self.evm(chain)
        if meta.native:
            return await evm.get_balance(record.address)
        return await evm.erc20_balance_of(meta.address, record.address)

    def _new_order(
        self,
        order_id: str,
        chain: ChainSpec,
        record: WalletRecord,
        meta_in: TokenMeta,
        meta_out: TokenMeta,
        amount_raw: int,
        slippage: float | None,
        initiator: str,
        session_key: str | None,
        note: str | None,
    ) -> dict[str, Any]:
        now = self._now()
        row = {
            "order_id": order_id,
            "created_at": now,
            "updated_at": now,
            "chain_id": chain.chain_id,
            "wallet": record.key,
            "token_in": meta_in.address,
            "token_out": meta_out.address,
            "amount_raw": str(amount_raw),
            "amount_human": format_amount(amount_raw, meta_in.decimals),
            "status": "quoted",
            "initiator": initiator,
            "session_key": session_key,
            "note": note,
            "slippage_pct": slippage,
            "provider": self.provider_id(),
        }
        self.ledger.insert_order(row)
        return row

    async def _process_order(self, row: dict[str, Any], *, wait: bool) -> None:
        """Quote, apply guardrails, and execute or park the order."""
        chain = CHAINS[int(row["chain_id"])]
        record = self.vault.get(str(row["wallet"]))
        meta_in = await self.token_meta(chain, str(row["token_in"]))
        meta_out = await self.token_meta(chain, str(row["token_out"]))
        amount_raw = int(row["amount_raw"])
        balance = await self._balance_raw(chain, record, meta_in)
        if balance < amount_raw:
            raise TradingError(
                "trading.insufficient_balance",
                f"{record.label} holds {format_amount(balance, meta_in.decimals)} "
                f"{meta_in.symbol or 'tokens'}, needs "
                f"{format_amount(amount_raw, meta_in.decimals)}",
            )
        provider = self.provider(str(row.get("provider") or ""))
        quote = await provider.quote(
            chain=chain,
            swapper=record.address,
            token_in=meta_in.address,
            token_out=meta_out.address,
            amount_raw=amount_raw,
            slippage_pct=row.get("slippage_pct"),
            decision_origin=_origin(str(row["initiator"])),
        )
        value = await self._value_usd(chain, meta_in, amount_raw)
        if value is None:
            value = await self._value_usd(chain, meta_out, quote.amount_out_raw)
        self.ledger.update_order(
            row["order_id"],
            expected_out_raw=str(quote.amount_out_raw),
            min_out_raw=str(quote.min_out_raw),
            value_usd=value,
            price_impact_pct=quote.price_impact_pct,
            gas_usd=quote.gas_usd,
            slippage_pct=quote.slippage_pct
            if quote.slippage_pct is not None
            else row.get("slippage_pct"),
        )
        verdict = guardrails.evaluate(
            initiator=str(row["initiator"]),
            value_usd=value,
            threshold_usd=self.config.approval_threshold_usd,
            daily_cap_usd=self.config.daily_cap_usd,
            spent_today_usd=self.ledger.spent_today(record.key),
        )
        if verdict.decision == "blocked_daily_cap":
            self.ledger.update_order(row["order_id"], status="rejected", reason=verdict.reason)
            await self._emit("trading.order.finished", {"order": self.get_order(row["order_id"])})
            return
        if verdict.decision == "needs_approval":
            ttl = int(self.config.approval_ttl_seconds)
            self.ledger.update_order(
                row["order_id"],
                status="awaiting_approval",
                reason=verdict.reason,
                expires_at=self._now() + ttl,
            )
            await self._emit(
                "trading.approval.requested", {"order": self.get_order(row["order_id"])}
            )
            return
        await self._execute(row["order_id"], quote, wait=wait)

    async def _execute(self, order_id: str, quote: ProviderQuote | None, *, wait: bool) -> None:
        row = self.ledger.get_order(order_id)
        assert row is not None
        chain = CHAINS[int(row["chain_id"])]
        record = self.vault.get(str(row["wallet"]))
        meta_in = await self.token_meta(chain, str(row["token_in"]))
        meta_out = await self.token_meta(chain, str(row["token_out"]))
        amount_raw = int(row["amount_raw"])
        key = self.vault.private_key(record.address)
        evm = self.evm(chain)
        provider = self.provider(str(row.get("provider") or ""))
        origin = _origin(str(row["initiator"]))
        # First contact with this wallet on this chain: book what it already
        # holds so the swap's cost basis and the balance cache start right.
        for token in {NATIVE_ADDRESS, meta_in.address, meta_out.address}:
            await self.syncer.ensure_opening(record, chain, token, evm)

        # 1. ERC-20 allowance for the provider's spender.
        if quote is None or not quote.fresh:
            quote = await provider.quote(
                chain=chain,
                swapper=record.address,
                token_in=meta_in.address,
                token_out=meta_out.address,
                amount_raw=amount_raw,
                slippage_pct=row.get("slippage_pct"),
                decision_origin=origin,
            )
        if not meta_in.native:
            approval_tx = await provider.approval_tx(quote, evm=evm, decision_origin=origin)
            if approval_tx is not None:
                tx_hash = await self._send(chain, record, key, approval_tx)
                self.ledger.update_order(order_id, approval_tx_hash=tx_hash)
                receipt = await evm.wait_for_receipt(tx_hash, timeout_s=RECEIPT_TIMEOUT_S)
                if not receipt_succeeded(receipt):
                    raise TradingError(
                        "trading.tx_failed", f"approval transaction failed ({tx_hash})"
                    )
                await self._record_gas(chain, record, receipt, kind="approval", order_id=order_id)

        # 2. Fresh quote (the approval may have taken a while).
        if not quote.fresh:
            quote = await provider.quote(
                chain=chain,
                swapper=record.address,
                token_in=meta_in.address,
                token_out=meta_out.address,
                amount_raw=amount_raw,
                slippage_pct=row.get("slippage_pct"),
                decision_origin=origin,
            )
        if row["status"] == "approved" and row.get("expected_out_raw"):
            expected = int(row["expected_out_raw"])
            slip = float(row.get("slippage_pct") or quote.slippage_pct or 0.5)
            floor = expected * (1 - 2 * slip / 100.0)
            if quote.amount_out_raw < floor:
                self.ledger.update_order(
                    order_id,
                    status="awaiting_approval",
                    reason="price moved since approval; please re-approve",
                    expected_out_raw=str(quote.amount_out_raw),
                    min_out_raw=str(quote.min_out_raw),
                    expires_at=self._now() + int(self.config.approval_ttl_seconds),
                )
                await self._emit("trading.approval.requested", {"order": self.get_order(order_id)})
                return
        self.ledger.update_order(
            order_id,
            expected_out_raw=str(quote.amount_out_raw),
            min_out_raw=str(quote.min_out_raw),
            price_impact_pct=quote.price_impact_pct,
            gas_usd=quote.gas_usd,
        )

        # 3. Calldata, sign, broadcast.
        tx = await provider.build(
            quote,
            deadline=int(self._now()) + 600,
            sign_permit=lambda permit: self._sign_permit(permit, key),
            decision_origin=origin,
        )
        validate_transaction(tx)
        if str(tx.get("from") or "").lower() != record.key:
            raise TradingError("trading.tx_failed", "swap transaction is not from this wallet")
        pre_in = await self._balance_raw(chain, record, meta_in)
        pre_out = await self._balance_raw(chain, record, meta_out)
        pre_native = await evm.get_balance(record.address)
        tx_hash = await self._send(chain, record, key, tx)
        self.ledger.update_order(order_id, status="submitted", tx_hash=tx_hash, reason=None)
        await self._emit("trading.changed", {"reason": "order", "orderId": order_id})
        pre = {"in": pre_in, "out": pre_out, "native": pre_native}
        if wait:
            await self._confirm(order_id, tx_hash, pre)
        else:
            loop = asyncio.get_running_loop()
            task = loop.create_task(
                self._confirm(order_id, tx_hash, pre), name=f"trading-confirm-{order_id}"
            )
            self._confirm_tasks.add(task)
            task.add_done_callback(self._confirm_tasks.discard)

    async def _send(
        self, chain: ChainSpec, record: WalletRecord, key: bytes, tx: dict[str, Any]
    ) -> str:
        evm = self.evm(chain)
        to = str(tx.get("to") or "")
        data = str(tx.get("data") or "0x")
        if not to or data in ("", "0x"):
            raise TradingError("trading.tx_failed", "transaction from Uniswap is incomplete")
        value = int(str(tx.get("value") or "0"), 0) if tx.get("value") else 0
        base_tx: dict[str, Any] = {"from": record.address, "to": to, "data": data, "value": value}
        native = await evm.get_balance(record.address)
        if native < value:
            raise TradingError(
                "trading.insufficient_balance", "not enough native balance for value"
            )
        try:
            await evm.simulate(base_tx)
        except EvmRpcError as exc:
            raise TradingError("trading.tx_failed", f"simulation reverted: {exc}") from exc
        gas_limit = int(str(tx.get("gasLimit") or "0"), 0) if tx.get("gasLimit") else 0
        if gas_limit <= 0:
            gas_limit = int(await evm.estimate_gas(base_tx) * 1.2)
        max_fee = int(str(tx.get("maxFeePerGas") or "0"), 0) if tx.get("maxFeePerGas") else 0
        max_priority = (
            int(str(tx.get("maxPriorityFeePerGas") or "0"), 0)
            if tx.get("maxPriorityFeePerGas")
            else 0
        )
        if max_fee <= 0:
            max_fee, max_priority = await evm.fee_data()
        if native < value + gas_limit * max_fee:
            raise TradingError(
                "trading.insufficient_balance",
                f"not enough {chain.native_symbol} for gas "
                f"(need ~{format_amount(value + gas_limit * max_fee, 18)})",
            )
        nonce = await evm.nonce(record.address)
        full_tx = {
            "chainId": chain.chain_id,
            "nonce": nonce,
            "to": to,
            "value": value,
            "data": data,
            "gas": gas_limit,
            "maxFeePerGas": max_fee,
            "maxPriorityFeePerGas": max_priority,
            "type": 2,
        }
        raw = self._sign_tx(full_tx, key)
        try:
            return await evm.send_raw_transaction(raw)
        except EvmRpcError as exc:
            raise TradingError("trading.tx_failed", f"broadcast rejected: {exc}") from exc

    async def _record_gas(
        self,
        chain: ChainSpec,
        record: WalletRecord,
        receipt: dict[str, Any] | None,
        *,
        kind: str,
        order_id: str | None,
    ) -> float | None:
        if not receipt:
            return None
        gas_wei = receipt_gas_wei(receipt)
        eth_price = await self.prices.price(chain, NATIVE_ADDRESS)
        gas_usd = float(to_human(gas_wei, 18)) * eth_price if eth_price is not None else None
        tx_hash = str(receipt.get("transactionHash") or "").lower() or None
        if kind == "approval":
            self.ledger.insert_entry(
                ts=self._now(),
                chain_id=chain.chain_id,
                wallet=record.key,
                kind="approval",
                tx_hash=tx_hash,
                log_index=0,
                gas_usd=gas_usd,
                initiator="manual",
                order_id=order_id,
            )
        return gas_usd

    async def _confirm(self, order_id: str, tx_hash: str, pre: dict[str, int]) -> None:
        row = self.ledger.get_order(order_id)
        if row is None:
            return
        chain = CHAINS[int(row["chain_id"])]
        record = self.vault.get(str(row["wallet"]))
        meta_in = await self.token_meta(chain, str(row["token_in"]))
        meta_out = await self.token_meta(chain, str(row["token_out"]))
        evm = self.evm(chain)
        try:
            receipt = await evm.wait_for_receipt(tx_hash, timeout_s=RECEIPT_TIMEOUT_S)
        except (EvmRpcError, EvmTransportError) as exc:
            receipt = None
            log.warning("trading.receipt_error", order=order_id, error=str(exc))
        if receipt is None:
            self.ledger.update_order(
                order_id, status="failed", reason="no receipt within the wait window"
            )
            await self._emit("trading.order.finished", {"order": self.get_order(order_id)})
            return
        gas_wei = receipt_gas_wei(receipt)
        eth_price = await self.prices.price(chain, NATIVE_ADDRESS)
        gas_usd = float(to_human(gas_wei, 18)) * eth_price if eth_price is not None else None
        if not receipt_succeeded(receipt):
            self.ledger.update_order(
                order_id,
                status="failed",
                reason="transaction reverted on-chain",
                gas_wei=str(gas_wei),
            )
            self.ledger.insert_entry(
                ts=self._now(),
                chain_id=chain.chain_id,
                wallet=record.key,
                kind="gas",
                tx_hash=tx_hash,
                log_index=0,
                gas_usd=gas_usd,
                initiator=str(row["initiator"]),
                order_id=order_id,
                note="reverted swap",
            )
            await self._emit("trading.order.finished", {"order": self.get_order(order_id)})
            return
        post_in = await self._balance_raw(chain, record, meta_in)
        post_out = await self._balance_raw(chain, record, meta_out)
        post_native = await evm.get_balance(record.address)
        transfers = receipt_transfers(receipt)
        # ERC-20 legs come from the receipt's Transfer logs: a load-balanced
        # RPC can still answer "latest" balances from a node that has not
        # seen the block yet, which would book the swap as received 0.
        spent = pre["in"] - post_in
        received = post_out - pre["out"]
        delivered = meta_out.address
        if not meta_in.native:
            left = sum(
                t.amount for t in transfers if t.token == meta_in.address and t.sender == record.key
            )
            if left > 0:
                spent = left
                post_in = pre["in"] - left
        if not meta_out.native:
            arrived = sum(
                t.amount
                for t in transfers
                if t.token == meta_out.address and t.recipient == record.key
            )
            if arrived > 0:
                received = arrived
                post_out = pre["out"] + arrived
        if meta_in.native:
            spent = (pre["native"] - post_native) - gas_wei
        if meta_out.native:
            received = (post_native - pre["native"]) + gas_wei
            # On an L2 the router may hand back WETH instead of unwrapping.
            weth = await self.weth_for(chain)
            if weth and received <= 0:
                arrived = sum(
                    t.amount for t in transfers if t.token == weth and t.recipient == record.key
                )
                if arrived > 0:
                    delivered = weth
                    received = arrived
                    meta_out = await self.token_meta(chain, weth)
        if spent <= 0:
            spent = int(row["amount_raw"])
        received = max(received, 0)
        block_number = int(str(receipt.get("blockNumber") or "0x0"), 16)
        ts = await evm.block_timestamp(block_number) if block_number else None
        await self.syncer._book_swap(
            record,
            chain,
            token_in=meta_in.address,
            amount_in=spent,
            token_out=delivered,
            amount_out=received,
            ts=float(ts or self._now()),
            tx_hash=tx_hash,
            log_index=0,
            initiator=str(row["initiator"]),
            gas_usd=gas_usd,
            order_id=order_id,
            session_key=row.get("session_key"),
            note=row.get("note"),
        )
        # Keep the balance cache consistent so the next sync does not book the
        # swap's native movement as a deposit/withdrawal.
        self.ledger.set_balance(chain.chain_id, record.key, NATIVE_ADDRESS, post_native)
        if not meta_in.native:
            self.ledger.set_balance(chain.chain_id, record.key, meta_in.address, post_in)
        if not meta_out.native:
            self.ledger.set_balance(chain.chain_id, record.key, meta_out.address, post_out)
        if row["initiator"] == "agent" and row.get("value_usd"):
            self.ledger.add_daily_spend(record.key, float(row["value_usd"]), local_day(self._now()))
        self.ledger.update_order(
            order_id,
            status="confirmed",
            reason=None,
            spent_in_raw=str(spent),
            received_out_raw=str(received),
            gas_wei=str(gas_wei),
            delivered_token=delivered,
        )
        self._wake(order_id)
        await self._emit("trading.order.finished", {"order": self.get_order(order_id)})
        await self._emit("trading.changed", {"reason": "order", "orderId": order_id})

    # ── approvals ──────────────────────────────────────────────────────

    def _wake(self, order_id: str) -> None:
        event = self._order_events.pop(order_id, None)
        if event is not None:
            event.set()

    async def approve(self, order_id: str, *, wait: bool = False) -> dict[str, Any]:
        row = self.ledger.get_order(order_id)
        if row is None:
            raise TradingError("trading.invalid", f"no order {order_id}")
        if row["status"] != "awaiting_approval":
            raise TradingError("trading.invalid", f"order {order_id} is {row['status']}")
        if row.get("expires_at") and float(row["expires_at"]) <= self._now():
            self.ledger.update_order(order_id, status="expired", reason="expired")
            raise TradingError("trading.quote_expired", f"order {order_id} expired")
        self.ledger.update_order(order_id, status="approved", reason=None)
        try:
            await self._execute(order_id, None, wait=wait)
        except Exception as exc:
            error = _err(exc)
            self.ledger.update_order(order_id, status="failed", reason=f"{error.code}: {error}")
            await self._emit("trading.order.finished", {"order": self.get_order(order_id)})
        self._wake(order_id)
        await self._emit("trading.changed", {"reason": "approval", "orderId": order_id})
        return self.get_order(order_id)

    async def reject(self, order_id: str, reason: str | None = None) -> dict[str, Any]:
        row = self.ledger.get_order(order_id)
        if row is None:
            raise TradingError("trading.invalid", f"no order {order_id}")
        if row["status"] != "awaiting_approval":
            raise TradingError("trading.invalid", f"order {order_id} is {row['status']}")
        self.ledger.update_order(
            order_id, status="rejected", reason=f"user: {reason}" if reason else "user"
        )
        self._wake(order_id)
        await self._emit("trading.order.finished", {"order": self.get_order(order_id)})
        await self._emit("trading.changed", {"reason": "approval", "orderId": order_id})
        return self.get_order(order_id)

    async def wait_order(self, order_id: str, timeout_s: float = 60.0) -> dict[str, Any]:
        deadline = self._now() + max(0.0, min(float(timeout_s), 900.0))
        while True:
            order = self.get_order(order_id)
            if order["status"] in ORDER_FINAL_STATUSES or order["status"] == "quoted":
                return order
            remaining = deadline - self._now()
            if remaining <= 0:
                return order
            event = self._order_events.setdefault(order_id, asyncio.Event())
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(event.wait(), timeout=min(remaining, 2.0))
            if event.is_set():
                self._order_events.pop(order_id, None)

    async def expire_orders(self) -> list[dict[str, Any]]:
        expired = self.ledger.expire_orders(self._now())
        out = []
        for row in expired:
            self._wake(str(row["order_id"]))
            order = self.get_order(str(row["order_id"]))
            out.append(order)
            await self._emit("trading.order.finished", {"order": order})
        if out:
            await self._emit("trading.changed", {"reason": "approval"})
        return out


# ── module singleton ───────────────────────────────────────────────────────

_service: TradingService | None = None


def get_trading_service(
    config: Any | None = None, *, broadcast: Broadcast | None = None
) -> TradingService:
    """The process-wide service, created from ``config`` on first use.

    ``config`` is the gateway config (anything with a ``trading`` attribute)
    or a bare ``TradingConfig``; ``broadcast`` is how events leave the engine
    (the gateway passes its WebSocket registry). Later calls may refresh
    both — a hot config write or a reconnected transport takes effect
    without rebuilding the ledger or re-unlocking the vault.
    """
    global _service
    if _service is None:
        if config is None:
            raise ValueError("get_trading_service needs a config on first use")
        _service = TradingService(config, broadcast=broadcast)
        return _service
    if config is not None:
        trading_cfg = getattr(config, "trading", config)
        _service.config = trading_cfg
        _service._gateway_config = config
    if broadcast is not None:
        _service._broadcast = broadcast
    return _service


def set_trading_service(service: TradingService | None) -> None:
    global _service
    _service = service


def reset_trading_service() -> None:
    set_trading_service(None)
