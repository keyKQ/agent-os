"""Code-enforced limits on agent-initiated swaps.

Pure functions: the service feeds them the numbers, they answer with a
decision. Nothing here can be influenced by prompt text — that is the point.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Decision = Literal["allow", "needs_approval", "blocked_daily_cap"]
Initiator = Literal["manual", "agent"]


@dataclass(frozen=True)
class GuardVerdict:
    decision: Decision
    value_usd: float | None
    spent_today_usd: float
    daily_cap_usd: float
    threshold_usd: float
    reason: str

    def to_dict(self) -> dict[str, object]:
        return {
            "decision": self.decision,
            "valueUsd": self.value_usd,
            "spentTodayUsd": round(self.spent_today_usd, 2),
            "dailyCapUsd": self.daily_cap_usd,
            "thresholdUsd": self.threshold_usd,
            "reason": self.reason,
        }


def evaluate(
    *,
    initiator: str,
    value_usd: float | None,
    threshold_usd: float,
    daily_cap_usd: float,
    spent_today_usd: float,
) -> GuardVerdict:
    """Decide what happens to a swap worth ``value_usd``.

    * Manual swaps are the user's own decision: always allowed.
    * An agent swap whose value cannot be priced fails closed into approval.
    * An agent swap that would push the wallet over its daily cap is refused
      outright (not queued: a queue would let the agent keep piling up asks).
    * Above the per-order threshold the swap waits for a human.
    """
    spent = max(0.0, float(spent_today_usd))
    cap = float(daily_cap_usd)
    threshold = float(threshold_usd)

    def verdict(decision: Decision, reason: str) -> GuardVerdict:
        return GuardVerdict(
            decision=decision,
            value_usd=value_usd,
            spent_today_usd=spent,
            daily_cap_usd=cap,
            threshold_usd=threshold,
            reason=reason,
        )

    if initiator == "manual":
        return verdict("allow", "manual")
    if value_usd is None:
        return verdict("needs_approval", "value unknown (no price)")
    value = float(value_usd)
    if cap > 0 and spent + value > cap:
        return verdict(
            "blocked_daily_cap",
            f"daily cap {cap:.2f} USD would be exceeded ({spent:.2f} spent + {value:.2f})",
        )
    if threshold >= 0 and value > threshold:
        return verdict(
            "needs_approval",
            f"order {value:.2f} USD is above the {threshold:.2f} USD threshold",
        )
    return verdict("allow", "within limits")
