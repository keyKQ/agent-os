"""Chain → ledger synchronisation.

For every wallet × chain: sweep ERC-20 ``Transfer`` logs since the last
synced block, classify each transaction (deposit / withdraw / external
swap — our own swaps are recorded by the service when they confirm), price
it at its block time, and keep the FIFO lots current. Native ETH has no
logs, so a change in the native balance that the ledger cannot explain is
booked as a deposit or withdrawal.

Everything here is idempotent: the entries table has a uniqueness key per
(wallet, kind, tx, log) and a full resync simply drops and rebuilds.
"""

from __future__ import annotations

import time
from collections import defaultdict
from collections.abc import Awaitable, Callable

import structlog

from agentos.trading.chains import NATIVE_ADDRESS, ChainSpec
from agentos.trading.evm import EvmClient, TransferLog
from agentos.trading.ledger import Ledger
from agentos.trading.pnl import per_raw, sell_fifo, to_human
from agentos.trading.prices import PriceService, TokenMeta
from agentos.trading.vault import WalletRecord

log = structlog.get_logger(__name__)

TokenMetaFn = Callable[[ChainSpec, str], Awaitable[TokenMeta]]
EvmFn = Callable[[ChainSpec], EvmClient]
WatchFn = Callable[[ChainSpec], Awaitable[list[str]]]

# An imported wallet's first sweep: about a day on Base, an hour on Robinhood.
DEFAULT_INITIAL_LOOKBACK = 50_000
DEFAULT_FULL_LOOKBACK = 2_000_000
# Ignore native dust drift below this (gas of a tx we did not see).
NATIVE_DUST_WEI = 10**13


class WalletSyncer:
    def __init__(
        self,
        ledger: Ledger,
        prices: PriceService,
        *,
        evm_for: EvmFn,
        token_meta: TokenMetaFn,
        watch_tokens: WatchFn | None = None,
        now: Callable[[], float] = time.time,
        initial_lookback: int = DEFAULT_INITIAL_LOOKBACK,
        full_lookback: int = DEFAULT_FULL_LOOKBACK,
    ) -> None:
        self.ledger = ledger
        self.prices = prices
        self._evm_for = evm_for
        self._token_meta = token_meta
        self._watch_tokens = watch_tokens
        self._now = now
        self.initial_lookback = initial_lookback
        self.full_lookback = full_lookback
        self._block_ts: dict[tuple[int, int], int] = {}

    # ── public ─────────────────────────────────────────────────────────

    async def sync(self, wallet: WalletRecord, chain: ChainSpec, *, full: bool = False) -> bool:
        evm = self._evm_for(chain)
        address = wallet.key
        latest = await evm.block_number()
        state = self.ledger.sync_state(chain.chain_id, address)
        if full:
            self.ledger.delete_chain_history(address, chain.chain_id)
            state = None
        if state is None:
            created = wallet.created_block.get(str(chain.chain_id))
            if created is not None and not full:
                start = int(created)
            else:
                lookback = self.full_lookback if full else self.initial_lookback
                start = max(0, latest - lookback)
            oldest: int | None = start
        else:
            start = int(state["last_block"]) + 1
            oldest = state.get("oldest_block")
        changed = False
        if start <= latest:
            logs = await evm.transfer_logs(address, from_block=start, to_block=latest)
            changed = await self._record_transfers(wallet, chain, logs) or changed
        changed = await self._reconcile_native(wallet, chain, evm) or changed
        changed = await self._refresh_balances(wallet, chain, evm) or changed
        await self._snapshot_prices(wallet, chain)
        self.ledger.set_sync_state(chain.chain_id, address, last_block=latest, oldest_block=oldest)
        return changed

    # ── transfers ──────────────────────────────────────────────────────

    async def _record_transfers(
        self, wallet: WalletRecord, chain: ChainSpec, logs: list[TransferLog]
    ) -> bool:
        address = wallet.key
        by_tx: dict[str, list[TransferLog]] = defaultdict(list)
        for entry in logs:
            by_tx[entry.tx_hash].append(entry)
        changed = False
        in_flight = {
            str(o.get("tx_hash") or "").lower()
            for o in self.ledger.list_orders(status="submitted,approved", wallet=address)
            if o.get("tx_hash")
        }
        for tx_hash, group in by_tx.items():
            if self.ledger.entries_for_tx(address, tx_hash):
                continue  # our own confirmed order, or already synced
            if tx_hash in in_flight:
                continue  # the confirmation path records it
            ins: dict[str, int] = defaultdict(int)
            outs: dict[str, int] = defaultdict(int)
            first_log_index = min(t.log_index for t in group)
            block = group[0].block_number
            for transfer in group:
                if transfer.recipient == address and transfer.sender != address:
                    ins[transfer.token] += transfer.amount
                elif transfer.sender == address and transfer.recipient != address:
                    outs[transfer.token] += transfer.amount
            ins = {k: v for k, v in ins.items() if v > 0}
            outs = {k: v for k, v in outs.items() if v > 0}
            if not ins and not outs:
                continue
            ts = await self._timestamp(chain, block)
            if ins and not outs:
                for token, amount in ins.items():
                    if await self._book_deposit(
                        wallet, chain, token, amount, ts, tx_hash=tx_hash, log_index=first_log_index
                    ):
                        changed = True
            elif outs and not ins:
                for token, amount in outs.items():
                    if await self._book_withdraw(
                        wallet, chain, token, amount, ts, tx_hash=tx_hash, log_index=first_log_index
                    ):
                        changed = True
            else:
                token_in, amount_in = max(outs.items(), key=lambda kv: kv[1])
                token_out, amount_out = max(ins.items(), key=lambda kv: kv[1])
                if await self._book_swap(
                    wallet,
                    chain,
                    token_in=token_in,
                    amount_in=amount_in,
                    token_out=token_out,
                    amount_out=amount_out,
                    ts=ts,
                    tx_hash=tx_hash,
                    log_index=first_log_index,
                    initiator="external",
                ):
                    changed = True
        return changed

    async def _timestamp(self, chain: ChainSpec, block: int) -> float:
        key = (chain.chain_id, block)
        cached = self._block_ts.get(key)
        if cached is not None:
            return float(cached)
        evm = self._evm_for(chain)
        ts = await evm.block_timestamp(block)
        if ts is None:
            ts = int(self._now())
        if len(self._block_ts) > 4096:
            self._block_ts.clear()
        self._block_ts[key] = ts
        return float(ts)

    # ── booking helpers (shared with the service) ──────────────────────

    async def _price_for(self, chain: ChainSpec, token: str, ts: float) -> tuple[float | None, str]:
        """USD price of one whole token at ``ts`` and where it came from."""
        recent = abs(self._now() - ts) < 3600
        if not recent:
            historical = await self.prices.price_at(chain, token, int(ts))
            if historical is not None:
                return historical, "historical"
        spot = await self.prices.price(chain, token)
        if spot is not None:
            return spot, "spot" if recent else "approx"
        return None, "unknown"

    async def _book_deposit(
        self,
        wallet: WalletRecord,
        chain: ChainSpec,
        token: str,
        amount: int,
        ts: float,
        *,
        tx_hash: str | None,
        log_index: int,
        note: str | None = None,
    ) -> bool:
        meta = await self._token_meta(chain, token)
        price, source = await self._price_for(chain, token, ts)
        value = float(to_human(amount, meta.decimals)) * price if price is not None else None
        entry_id = self.ledger.insert_entry(
            ts=ts,
            chain_id=chain.chain_id,
            wallet=wallet.key,
            kind="deposit",
            tx_hash=tx_hash,
            log_index=log_index,
            token_out=token,
            amount_out_raw=amount,
            value_usd=value,
            price_out_usd=price,
            cost_basis_source=source,
            initiator="external",
            note=note,
        )
        if entry_id is None:
            return False
        self.ledger.add_lot(
            chain.chain_id,
            wallet.key,
            token,
            amount_raw=amount,
            cost_usd_per_raw=per_raw(price, meta.decimals) if price is not None else 0.0,
            acquired_at=ts,
            entry_id=entry_id,
        )
        return True

    async def _book_withdraw(
        self,
        wallet: WalletRecord,
        chain: ChainSpec,
        token: str,
        amount: int,
        ts: float,
        *,
        tx_hash: str | None,
        log_index: int,
        note: str | None = None,
    ) -> bool:
        meta = await self._token_meta(chain, token)
        price, source = await self._price_for(chain, token, ts)
        value = float(to_human(amount, meta.decimals)) * price if price is not None else None
        entry_id = self.ledger.insert_entry(
            ts=ts,
            chain_id=chain.chain_id,
            wallet=wallet.key,
            kind="withdraw",
            tx_hash=tx_hash,
            log_index=log_index,
            token_in=token,
            amount_in_raw=amount,
            value_usd=value,
            price_in_usd=price,
            cost_basis_source=source,
            initiator="external",
            note=note,
        )
        if entry_id is None:
            return False
        self._consume(chain, wallet.key, token, amount, value, ts, entry_id)
        return True

    async def _book_swap(
        self,
        wallet: WalletRecord,
        chain: ChainSpec,
        *,
        token_in: str,
        amount_in: int,
        token_out: str,
        amount_out: int,
        ts: float,
        tx_hash: str | None,
        log_index: int,
        initiator: str,
        gas_usd: float | None = None,
        order_id: str | None = None,
        session_key: str | None = None,
        note: str | None = None,
    ) -> bool:
        meta_in = await self._token_meta(chain, token_in)
        meta_out = await self._token_meta(chain, token_out)
        price_in, source_in = await self._price_for(chain, token_in, ts)
        price_out, source_out = await self._price_for(chain, token_out, ts)
        human_in = float(to_human(amount_in, meta_in.decimals))
        human_out = float(to_human(amount_out, meta_out.decimals))
        value: float | None
        source: str
        if price_in is not None:
            value, source = human_in * price_in, source_in
        elif price_out is not None:
            value, source = human_out * price_out, source_out
        else:
            value, source = None, "unknown"
        entry_id = self.ledger.insert_entry(
            ts=ts,
            chain_id=chain.chain_id,
            wallet=wallet.key,
            kind="swap",
            tx_hash=tx_hash,
            log_index=log_index,
            token_in=token_in,
            amount_in_raw=amount_in,
            token_out=token_out,
            amount_out_raw=amount_out,
            value_usd=value,
            gas_usd=gas_usd,
            price_in_usd=price_in,
            price_out_usd=price_out,
            cost_basis_source=source,
            initiator=initiator,
            order_id=order_id,
            session_key=session_key,
            note=note,
        )
        if entry_id is None:
            return False
        self._consume(chain, wallet.key, token_in, amount_in, value, ts, entry_id)
        if amount_out > 0:
            cost_per_raw = (value / amount_out) if value is not None else 0.0
            self.ledger.add_lot(
                chain.chain_id,
                wallet.key,
                token_out,
                amount_raw=amount_out,
                cost_usd_per_raw=cost_per_raw,
                acquired_at=ts,
                entry_id=entry_id,
            )
        return True

    def _consume(
        self,
        chain: ChainSpec,
        wallet: str,
        token: str,
        amount: int,
        proceeds_usd: float | None,
        ts: float,
        entry_id: int,
    ) -> None:
        lots = self.ledger.open_lots(chain.chain_id, wallet, token)
        result = sell_fifo(lots, amount, proceeds_usd)
        self.ledger.save_lots(lots)
        matched = amount - result.unmatched_raw
        if matched > 0:
            self.ledger.add_realized(
                entry_id=entry_id,
                chain_id=chain.chain_id,
                wallet=wallet,
                token=token,
                amount_raw=matched,
                proceeds_usd=result.proceeds_usd,
                cost_usd=result.cost_usd,
                ts=ts,
            )

    # ── native / balances / snapshots ──────────────────────────────────

    async def _reconcile_native(
        self, wallet: WalletRecord, chain: ChainSpec, evm: EvmClient
    ) -> bool:
        balance = await evm.get_balance(wallet.address)
        cached = self.ledger.get_balance(chain.chain_id, wallet.key, NATIVE_ADDRESS)
        changed = False
        ts = self._now()
        if cached is None:
            if balance > 0:
                changed = await self._book_deposit(
                    wallet,
                    chain,
                    NATIVE_ADDRESS,
                    balance,
                    ts,
                    tx_hash=None,
                    log_index=int(ts),
                    note="opening balance",
                )
        else:
            diff = balance - cached
            if diff > NATIVE_DUST_WEI:
                changed = await self._book_deposit(
                    wallet, chain, NATIVE_ADDRESS, diff, ts, tx_hash=None, log_index=int(ts)
                )
            elif diff < -NATIVE_DUST_WEI:
                changed = await self._book_withdraw(
                    wallet, chain, NATIVE_ADDRESS, -diff, ts, tx_hash=None, log_index=int(ts)
                )
        self.ledger.set_balance(chain.chain_id, wallet.key, NATIVE_ADDRESS, balance)
        return changed

    async def tokens_of_interest(self, wallet: str, chain: ChainSpec) -> list[str]:
        """ERC-20s worth reading for a wallet: held, seen, or well-known on the chain."""
        tokens: set[str] = set()
        for pos in self.ledger.positions(wallet):
            if pos.chain_id == chain.chain_id and pos.token != NATIVE_ADDRESS:
                tokens.add(pos.token)
        for row in self.ledger.balances(wallet, chain.chain_id):
            if row["token"] != NATIVE_ADDRESS:
                tokens.add(str(row["token"]))
        if self._watch_tokens is not None:
            for token in await self._watch_tokens(chain):
                if token and token != NATIVE_ADDRESS:
                    tokens.add(token.lower())
        return sorted(tokens)

    async def ensure_opening(
        self, wallet: WalletRecord, chain: ChainSpec, token: str, evm: EvmClient
    ) -> bool:
        """First sight of a token in a wallet: book what is there as an opening lot."""
        if self.ledger.get_balance(chain.chain_id, wallet.key, token) is not None:
            return False
        if token == NATIVE_ADDRESS:
            return await self._reconcile_native(wallet, chain, evm)
        raw = await evm.erc20_balance_of(token, wallet.address)
        # Only the part the lots cannot explain is an opening balance; the
        # rest arrived through Transfer logs the sweep already booked.
        held = sum(
            lot.amount_raw for lot in self.ledger.open_lots(chain.chain_id, wallet.key, token)
        )
        unexplained = raw - held
        changed = False
        if unexplained > 0:
            ts = self._now()
            changed = await self._book_deposit(
                wallet,
                chain,
                token,
                unexplained,
                ts,
                tx_hash=None,
                log_index=int(ts),
                note="opening balance",
            )
        self.ledger.set_balance(chain.chain_id, wallet.key, token, raw)
        return changed

    async def _refresh_balances(
        self, wallet: WalletRecord, chain: ChainSpec, evm: EvmClient
    ) -> bool:
        tokens = await self.tokens_of_interest(wallet.key, chain)
        if not tokens:
            return False
        changed = False
        fresh = [
            t for t in tokens if self.ledger.get_balance(chain.chain_id, wallet.key, t) is None
        ]
        for token in fresh:
            changed = await self.ensure_opening(wallet, chain, token, evm) or changed
        known = [t for t in tokens if t not in fresh]
        if known:
            balances = await evm.erc20_balances(wallet.address, known)
            for token, raw in balances.items():
                self.ledger.set_balance(chain.chain_id, wallet.key, token, raw)
        return changed

    async def _snapshot_prices(self, wallet: WalletRecord, chain: ChainSpec) -> None:
        tokens = [
            t
            for t in await self.tokens_of_interest(wallet.key, chain)
            if (self.ledger.get_balance(chain.chain_id, wallet.key, t) or 0) > 0
        ]
        wanted = [*tokens, NATIVE_ADDRESS]
        prices = await self.prices.prices(chain, wanted)
        ts = float(int(self._now()))
        for token, info in prices.items():
            if info.price_usd is not None:
                self.ledger.add_snapshot(chain.chain_id, token, ts, info.price_usd)


def summarize_transfers(logs: list[TransferLog], wallet: str) -> dict[str, dict[str, int]]:
    """Net in/out per token for a wallet (test helper and debugging aid)."""
    ins: dict[str, int] = defaultdict(int)
    outs: dict[str, int] = defaultdict(int)
    for transfer in logs:
        if transfer.recipient == wallet:
            ins[transfer.token] += transfer.amount
        if transfer.sender == wallet:
            outs[transfer.token] += transfer.amount
    return {"in": dict(ins), "out": dict(outs)}
