from __future__ import annotations

import httpx
import pytest

from agentos.trading.chains import BASE, NATIVE_ADDRESS, ROBINHOOD
from agentos.trading.evm import EvmClient
from agentos.trading.ledger import Ledger, local_day
from agentos.trading.prices import PriceService, TokenMeta, native_token
from agentos.trading.sync import WalletSyncer, summarize_transfers
from agentos.trading.vault import WalletRecord
from tests.test_trading.fakes import AAPL, OTHER, USDC, WALLET, WETH, FakeChain, FakePrices


class TestLedger:
    def test_entries_are_idempotent_and_ordered(self, ledger: Ledger) -> None:
        first = ledger.insert_entry(
            ts=10,
            chain_id=8453,
            wallet=WALLET,
            kind="deposit",
            tx_hash="0xA",
            log_index=1,
            token_out=USDC,
            amount_out_raw=5 * 10**6,
            value_usd=5.0,
            initiator="external",
        )
        dup = ledger.insert_entry(
            ts=10,
            chain_id=8453,
            wallet=WALLET,
            kind="deposit",
            tx_hash="0xa",
            log_index=1,
            token_out=USDC,
            amount_out_raw=5 * 10**6,
        )
        second = ledger.insert_entry(
            ts=20,
            chain_id=8453,
            wallet=WALLET,
            kind="withdraw",
            tx_hash="0xB",
            log_index=0,
            token_in=USDC,
            amount_in_raw=1,
        )
        assert first and second and dup is None
        assert ledger.entry_exists(WALLET, "deposit", "0xA", 1)
        rows = ledger.list_entries(wallet=WALLET)
        assert [r["kind"] for r in rows] == ["withdraw", "deposit"]
        assert ledger.list_entries(kind="deposit")[0]["amount_out_raw"] == str(5 * 10**6)
        assert ledger.list_entries(before=15)[0]["kind"] == "deposit"
        assert ledger.list_entries(chain_id=4663) == []
        assert len(ledger.entries_for_tx(WALLET, "0xa")) == 1

    def test_big_amounts_survive(self, ledger: Ledger) -> None:
        huge = 2**200
        ledger.add_lot(
            8453,
            WALLET,
            USDC,
            amount_raw=huge,
            cost_usd_per_raw=1e-30,
            acquired_at=1,
            entry_id=None,
        )
        assert ledger.open_lots(8453, WALLET, USDC)[0].amount_raw == huge
        assert ledger.positions(WALLET)[0].amount_raw == huge

    def test_lots_positions_realized(self, ledger: Ledger) -> None:
        ledger.add_lot(
            8453, WALLET, USDC, amount_raw=100, cost_usd_per_raw=1.0, acquired_at=1, entry_id=1
        )
        ledger.add_lot(
            8453, WALLET, USDC, amount_raw=50, cost_usd_per_raw=2.0, acquired_at=2, entry_id=2
        )
        ledger.add_lot(
            8453, OTHER, USDC, amount_raw=7, cost_usd_per_raw=1.0, acquired_at=3, entry_id=3
        )
        positions = {(p.wallet, p.token): p for p in ledger.positions()}
        assert positions[(WALLET, USDC)].amount_raw == 150
        assert positions[(WALLET, USDC)].cost_usd == pytest.approx(200.0)
        assert len(ledger.positions(WALLET)) == 1
        lots = ledger.open_lots(8453, WALLET, USDC)
        lots[0].amount_raw = 0
        ledger.save_lots(lots)
        assert [lot.amount_raw for lot in ledger.open_lots(8453, WALLET, USDC)] == [50]
        ledger.add_realized(
            entry_id=9,
            chain_id=8453,
            wallet=WALLET,
            token=USDC,
            amount_raw=100,
            proceeds_usd=150.0,
            cost_usd=100.0,
            ts=5,
        )
        assert ledger.realized_by_position(WALLET)[(8453, WALLET, USDC)] == pytest.approx(50.0)
        ledger.update_lot_cost(lots[1].lot_id or 0, 3.0)
        assert ledger.open_lots(8453, WALLET, USDC)[0].cost_usd_per_raw == 3.0

    def test_orders_lifecycle_and_expiry(self, ledger: Ledger) -> None:
        base = {
            "chain_id": 8453,
            "wallet": WALLET,
            "token_in": USDC,
            "token_out": WETH,
            "amount_raw": "1",
            "amount_human": "0.000001",
            "initiator": "agent",
        }
        ledger.insert_order(
            {
                **base,
                "order_id": "o1",
                "created_at": 1,
                "updated_at": 1,
                "status": "awaiting_approval",
                "expires_at": 100,
            }
        )
        ledger.insert_order(
            {
                **base,
                "order_id": "o2",
                "created_at": 2,
                "updated_at": 2,
                "status": "awaiting_approval",
                "expires_at": 500,
            }
        )
        ledger.insert_order(
            {**base, "order_id": "o3", "created_at": 3, "updated_at": 3, "status": "confirmed"}
        )
        assert ledger.count_orders("awaiting_approval") == 2
        assert [o["order_id"] for o in ledger.list_orders()] == ["o3", "o2", "o1"]
        assert [o["order_id"] for o in ledger.list_orders(status="confirmed,expired")] == ["o3"]
        expired = ledger.expire_orders(now=200)
        assert [o["order_id"] for o in expired] == ["o1"]
        assert ledger.get_order("o1")["status"] == "expired"
        assert ledger.count_orders("awaiting_approval") == 1
        updated = ledger.update_order("o2", status="approved", reason=None)
        assert updated and updated["status"] == "approved"
        assert ledger.get_order("nope") is None

    def test_daily_spend_balances_snapshots_sync_state(self, ledger: Ledger) -> None:
        day = local_day(0)
        ledger.add_daily_spend(WALLET, 10.0, day)
        ledger.add_daily_spend(WALLET, 2.5, day)
        assert ledger.spent_today(WALLET, day) == pytest.approx(12.5)
        assert ledger.spent_today(OTHER, day) == 0.0
        ledger.set_balance(8453, WALLET, USDC, 5)
        ledger.set_balance(8453, WALLET, USDC, 7)
        assert ledger.get_balance(8453, WALLET, USDC) == 7
        assert ledger.get_balance(8453, WALLET, WETH) is None
        assert len(ledger.balances(WALLET, 8453)) == 1
        ledger.add_snapshot(8453, USDC, 100, 1.0)
        ledger.add_snapshot(8453, USDC, 200, 1.1)
        assert [s["price_usd"] for s in ledger.snapshots(8453, USDC, since=150)] == [1.1]
        ledger.prune_snapshots(older_than=150)
        assert len(ledger.snapshots(8453, USDC, since=0)) == 1
        assert ledger.sync_state(8453, WALLET) is None
        ledger.set_sync_state(8453, WALLET, last_block=99, oldest_block=1)
        assert ledger.sync_state(8453, WALLET)["last_block"] == 99

    def test_tokens_and_wallet_mirror(self, ledger: Ledger) -> None:
        ledger.upsert_token(8453, USDC, symbol="USDC", name="USD Coin", decimals=6, verified=True)
        ledger.upsert_token(8453, USDC, symbol="", name="", decimals=6, logo_url="https://l")
        row = ledger.get_token(8453, USDC)
        assert (
            row
            and row["symbol"] == "USDC"
            and row["logo_url"] == "https://l"
            and row["verified"] == 1
        )
        assert len(ledger.tokens(8453)) == 1 and ledger.tokens(4663) == []
        ledger.upsert_wallet(WALLET, label="A", is_primary=True, created_at=1.0)
        ledger.set_balance(8453, WALLET, USDC, 1)
        ledger.remove_wallet(WALLET)
        assert ledger.balances(WALLET) == []

    def test_delete_chain_history(self, ledger: Ledger) -> None:
        ledger.insert_entry(
            ts=1, chain_id=8453, wallet=WALLET, kind="deposit", tx_hash="0x1", log_index=0
        )
        ledger.insert_entry(
            ts=1, chain_id=4663, wallet=WALLET, kind="deposit", tx_hash="0x2", log_index=0
        )
        ledger.add_lot(
            8453, WALLET, USDC, amount_raw=1, cost_usd_per_raw=1, acquired_at=1, entry_id=None
        )
        ledger.delete_chain_history(WALLET, 8453)
        assert [e["chain_id"] for e in ledger.list_entries(wallet=WALLET)] == [4663]
        assert ledger.positions(WALLET) == []


@pytest.fixture
def prices_fake() -> FakePrices:
    prices = FakePrices()
    prices.spot[("base", USDC)] = 1.0
    prices.spot[("base", WETH)] = 2000.0
    prices.history[USDC] = 1.0
    prices.history[WETH] = 1500.0
    prices.lists["base"] = [
        {"chainId": 8453, "address": USDC, "symbol": "USDC", "name": "USD Coin", "decimals": 6},
        {
            "chainId": 8453,
            "address": WETH,
            "symbol": "WETH",
            "name": "Wrapped Ether",
            "decimals": 18,
        },
    ]
    return prices


@pytest.fixture
def chain() -> FakeChain:
    c = FakeChain(chain_id=8453, block=10_000)
    c.tokens[USDC] = ("USDC", "USD Coin", 6)
    c.tokens[WETH] = ("WETH", "Wrapped Ether", 18)
    return c


@pytest.fixture
async def syncer(ledger: Ledger, chain: FakeChain, prices_fake: FakePrices):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "mainnet.base.org":
            return chain.handle(request)
        return prices_fake.handle(request)

    clock = {"now": 1_700_100_000.0}
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        prices = PriceService(http=http, ttl_s=0, now=lambda: clock["now"])
        evm = EvmClient("https://mainnet.base.org", http=http)

        async def token_meta(spec, address: str) -> TokenMeta:
            if address == NATIVE_ADDRESS:
                return native_token(spec)
            known = await prices.known_token(spec, address)
            if known:
                ledger.upsert_token(
                    spec.chain_id,
                    address,
                    symbol=known.symbol,
                    name=known.name,
                    decimals=known.decimals,
                    verified=True,
                )
                return known
            return TokenMeta(spec.chain_id, address, "", "", 18)

        async def watch(spec) -> list[str]:
            return [USDC, WETH]

        s = WalletSyncer(
            ledger,
            prices,
            evm_for=lambda spec: evm,
            token_meta=token_meta,
            watch_tokens=watch,
            now=lambda: clock["now"],
        )
        s.clock = clock  # type: ignore[attr-defined]
        yield s


def _wallet(created_block: int | None = 9_000) -> WalletRecord:
    record = WalletRecord(address=WALLET, label="W", created_at=1.0, imported=created_block is None)
    if created_block is not None:
        record.created_block["8453"] = created_block
    return record


class TestWalletSyncer:
    async def test_deposit_withdraw_and_external_swap(
        self, syncer: WalletSyncer, chain: FakeChain, ledger: Ledger
    ) -> None:
        # Historical deposit: priced through CoinGecko (block 9_100 -> ts 1_700_018_200, old).
        chain.add_transfer(
            token=USDC, sender=OTHER, recipient=WALLET, amount=100 * 10**6, block=9_100
        )
        # An external swap in one tx: 50 USDC out, 0.03 WETH in.
        tx = chain.add_transfer(
            token=USDC, sender=WALLET, recipient=OTHER, amount=50 * 10**6, block=9_200
        )
        chain.add_transfer(
            token=WETH,
            sender=OTHER,
            recipient=WALLET,
            amount=3 * 10**16,
            block=9_200,
            tx_hash=tx,
            log_index=1,
        )
        # A withdrawal.
        chain.add_transfer(token=WETH, sender=WALLET, recipient=OTHER, amount=10**16, block=9_300)
        chain.set_erc20(USDC, WALLET, 50 * 10**6)
        chain.set_erc20(WETH, WALLET, 2 * 10**16)
        chain.set_native(WALLET, 0)

        changed = await syncer.sync(_wallet(), BASE)
        assert changed is True
        kinds = [e["kind"] for e in ledger.list_entries(wallet=WALLET)]
        assert kinds == ["withdraw", "swap", "deposit"]
        deposit = ledger.list_entries(wallet=WALLET, kind="deposit")[0]
        assert deposit["cost_basis_source"] == "historical"
        assert deposit["value_usd"] == pytest.approx(100.0)
        swap = ledger.list_entries(wallet=WALLET, kind="swap")[0]
        assert swap["initiator"] == "external"
        assert swap["token_in"] == USDC and swap["token_out"] == WETH
        assert swap["value_usd"] == pytest.approx(50.0)
        positions = {p.token: p for p in ledger.positions(WALLET)}
        assert positions[USDC].amount_raw == 50 * 10**6
        assert positions[USDC].cost_usd == pytest.approx(50.0)
        # WETH lot cost = the 50 USD that bought 0.03, minus the 0.01 sold.
        assert positions[WETH].amount_raw == 2 * 10**16
        assert positions[WETH].cost_usd == pytest.approx(50.0 * 2 / 3)
        realized = ledger.realized_by_position(WALLET)
        assert realized[(8453, WALLET, USDC)] == pytest.approx(0.0)
        # Sold 0.01 WETH bought at 1666.67/ETH for 1500 (historical) -> loss.
        assert realized[(8453, WALLET, WETH)] == pytest.approx(15.0 - 50.0 / 3, abs=0.01)
        assert ledger.sync_state(8453, WALLET)["last_block"] == 10_000
        assert ledger.get_balance(8453, WALLET, USDC) == 50 * 10**6
        assert ledger.get_balance(8453, WALLET, NATIVE_ADDRESS) == 0
        # Snapshots exist for the held tokens.
        assert ledger.snapshots(8453, USDC, since=0)

        # Second sync is incremental and idempotent.
        assert await syncer.sync(_wallet(), BASE) is False
        assert len(ledger.list_entries(wallet=WALLET)) == 3

    async def test_native_balance_reconciliation(
        self, syncer: WalletSyncer, chain: FakeChain, ledger: Ledger
    ) -> None:
        chain.set_native(WALLET, 10**18)
        await syncer.sync(_wallet(), BASE)
        opening = ledger.list_entries(wallet=WALLET)[0]
        assert opening["kind"] == "deposit" and opening["note"] == "opening balance"
        assert opening["value_usd"] == pytest.approx(2000.0)
        chain.set_native(WALLET, 15 * 10**17)
        await syncer.sync(_wallet(), BASE)
        assert ledger.list_entries(wallet=WALLET)[0]["amount_out_raw"] == str(5 * 10**17)
        chain.set_native(WALLET, 10**18)
        chain.block += 1
        await syncer.sync(_wallet(), BASE)
        latest = ledger.list_entries(wallet=WALLET)[0]
        assert latest["kind"] == "withdraw" and latest["amount_in_raw"] == str(5 * 10**17)
        pos = {p.token: p for p in ledger.positions(WALLET)}[NATIVE_ADDRESS]
        assert pos.amount_raw == 10**18
        # Dust drift (gas) is ignored.
        chain.set_native(WALLET, 10**18 - 10**12)
        chain.block += 1
        assert await syncer.sync(_wallet(), BASE) is False

    async def test_imported_wallet_lookback_and_full_resync(
        self, syncer: WalletSyncer, chain: FakeChain, ledger: Ledger
    ) -> None:
        syncer.initial_lookback = 500
        chain.add_transfer(
            token=USDC, sender=OTHER, recipient=WALLET, amount=1, block=9_000
        )  # too old
        chain.add_transfer(token=USDC, sender=OTHER, recipient=WALLET, amount=2, block=9_900)
        chain.set_erc20(USDC, WALLET, 3)
        await syncer.sync(_wallet(created_block=None), BASE)
        deposits = ledger.list_entries(wallet=WALLET, kind="deposit")
        # The log inside the window is booked as a transfer; the older 1 unit the
        # sweep did not see shows up as an "opening balance" from the on-chain read.
        assert sorted((e["amount_out_raw"], e["note"]) for e in deposits) == [
            ("1", "opening balance"),
            ("2", None),
        ]
        assert ledger.sync_state(8453, WALLET)["oldest_block"] == 9_500
        syncer.full_lookback = 5_000
        await syncer.sync(_wallet(created_block=None), BASE, full=True)
        deposits = ledger.list_entries(wallet=WALLET, kind="deposit")
        assert sorted((e["amount_out_raw"], e["note"]) for e in deposits) == [
            ("1", None),
            ("2", None),
        ]

    async def test_in_flight_order_is_left_to_confirmation(
        self, syncer: WalletSyncer, chain: FakeChain, ledger: Ledger
    ) -> None:
        tx = chain.add_transfer(token=USDC, sender=WALLET, recipient=OTHER, amount=5, block=9_950)
        ledger.insert_order(
            {
                "order_id": "o1",
                "created_at": 1,
                "updated_at": 1,
                "chain_id": 8453,
                "wallet": WALLET,
                "token_in": USDC,
                "token_out": WETH,
                "amount_raw": "5",
                "amount_human": "0.000005",
                "status": "submitted",
                "initiator": "agent",
                "tx_hash": tx,
            }
        )
        await syncer.sync(_wallet(), BASE)
        assert ledger.list_entries(wallet=WALLET, kind="withdraw") == []

    async def test_unknown_price_books_zero_cost(
        self, syncer: WalletSyncer, chain: FakeChain, ledger: Ledger
    ) -> None:
        chain.add_transfer(token=AAPL, sender=OTHER, recipient=WALLET, amount=10**18, block=9_990)
        await syncer.sync(_wallet(), BASE)
        entry = ledger.list_entries(wallet=WALLET, kind="deposit")[0]
        assert entry["value_usd"] is None and entry["cost_basis_source"] == "unknown"
        assert ledger.positions(WALLET)[0].cost_usd == 0.0

    def test_summarize_helper(self) -> None:
        from agentos.trading.evm import TransferLog

        logs = [
            TransferLog("0x1", 0, 1, USDC, OTHER, WALLET, 5),
            TransferLog("0x1", 1, 1, USDC, WALLET, OTHER, 2),
        ]
        assert summarize_transfers(logs, WALLET) == {"in": {USDC: 5}, "out": {USDC: 2}}

    def test_robinhood_chain_spec_has_no_hardcoded_weth(self) -> None:
        assert ROBINHOOD.weth is None and BASE.weth is not None
