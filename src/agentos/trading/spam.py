"""Junk tokens: decide which of a wallet's tokens are worth showing.

Anyone can airdrop a token to any address, and the ones that arrive
uninvited are almost all junk — "visit site to claim" lures, dead
forks, dust. Left alone they bury the real holdings, swell the sync's scan
set and cost a price lookup each. Deleting them is wrong (the balance is
real and the ledger must explain it), so they are *hidden*: kept in the
ledger, kept out of what the user and the agent see.

A token is hidden automatically when all three hold:

1. Nobody lists it: it is not in the chain's CoinGecko registry (``verified``).
2. Nobody trades it: the price source answered and found no pool with at
   least :data:`MIN_LIQUIDITY_USD` behind it. Unreachable is not "no pool".
3. The wallet never acted on it: never sold, sent, swapped or quoted it
   (``touched`` / spent). Junk only ever arrives.

A hidden token is re-checked daily, so a real launch that gained a pool
resurfaces on its own. A user's hide/show is final: the classifier never
overrides ``hidden_by = 'user'``, and any deliberate act on a token (a
quote, a swap) shows it again.
"""

from __future__ import annotations

import time
from collections.abc import Callable

import structlog

from agentos.trading.chains import ChainSpec, is_native, normalize_address
from agentos.trading.ledger import Ledger
from agentos.trading.prices import PriceService

log = structlog.get_logger(__name__)

# A pool shallower than this cannot be sold into; for trading it is no pool.
MIN_LIQUIDITY_USD = 1_000.0
# How often a hidden token is looked at again.
RECLASSIFY_S = 24 * 3600.0


class TokenCurator:
    def __init__(
        self,
        ledger: Ledger,
        prices: PriceService,
        *,
        now: Callable[[], float] = time.time,
        min_liquidity_usd: float = MIN_LIQUIDITY_USD,
        reclassify_s: float = RECLASSIFY_S,
    ) -> None:
        self.ledger = ledger
        self.prices = prices
        self._now = now
        self.min_liquidity_usd = min_liquidity_usd
        self.reclassify_s = reclassify_s

    async def review(self, chain: ChainSpec, address: str, *, force: bool = False) -> bool:
        """Classify the token if it is due, and say whether it is hidden now.

        Cheap when nothing is due: two ledger reads. The price lookup runs
        once when a token is first met and then daily while it stays hidden.
        """
        if is_native(address):
            return False
        key = normalize_address(address)
        row = self.ledger.get_token(chain.chain_id, key)
        if row is None or row["is_native"]:
            return False
        hidden = bool(row["hidden"])
        if row.get("hidden_by") == "user":
            return hidden
        if row["verified"] or row["touched"]:
            if hidden:
                self.ledger.set_token_hidden(
                    chain.chain_id, key, False, by="auto", classified_at=self._now()
                )
            return False
        classified_at = row.get("classified_at")
        due = (
            force
            or classified_at is None
            or (hidden and self._now() - float(classified_at) >= self.reclassify_s)
        )
        if not due:
            return hidden
        verdict = await self._is_junk(chain, key)
        if verdict is None:
            # No answer from the price source: leave the token as it is and
            # ask again next time, rather than hiding something real.
            return hidden
        self.ledger.set_token_hidden(
            chain.chain_id, key, verdict, by="auto", classified_at=self._now()
        )
        if verdict != hidden:
            log.info(
                "trading.token_hidden" if verdict else "trading.token_shown",
                chain=chain.key,
                token=key,
            )
        return verdict

    async def _is_junk(self, chain: ChainSpec, key: str) -> bool | None:
        if self.ledger.token_was_spent(chain.chain_id, key):
            return False
        info = (await self.prices.prices(chain, [key])).get(key)
        if info is None or info.unavailable:
            return None
        return (info.liquidity_usd or 0.0) < self.min_liquidity_usd
