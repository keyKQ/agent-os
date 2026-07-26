"""Periodic memory-review nudge.

Curated memory only fills up when something asks the agent to write to it, so
the nudge is what turns "the agent *can* save memories" into "the agent
*does*". These tests pin the counter's arithmetic and, more importantly, the
cases where it must stay quiet: machine traffic, self-directed writes, and
reviews reviewing themselves.
"""

from __future__ import annotations

from typing import Any

import pytest

from agentos.engine.runtime import TurnRunner
from agentos.gateway.config import MemoryNudgeConfig


class _Cfg:
    """Minimal stand-in for the memory config block."""

    def __init__(self, nudge: MemoryNudgeConfig | None) -> None:
        self.nudge = nudge


class _Runner:
    """TurnRunner counter surface, unbound from the full runtime.

    The nudge methods only touch `_config` and `_memory_nudge_counters`, so
    binding them onto a bare object exercises the real implementations
    without standing up a gateway.
    """

    def __init__(self, nudge: MemoryNudgeConfig | None) -> None:
        self._config = type("C", (), {"memory": _Cfg(nudge)})()
        self._memory_nudge_counters: dict[tuple[str, str], int] = {}

    _memory_nudge_config = TurnRunner._memory_nudge_config
    _memory_nudge_allowed = TurnRunner._memory_nudge_allowed
    _turn_used_memory_tool = staticmethod(TurnRunner._turn_used_memory_tool)
    _capture_filter_matches = staticmethod(TurnRunner._capture_filter_matches)
    _hydrate_nudge_counter = staticmethod(TurnRunner._hydrate_nudge_counter)
    _note_turn_for_memory_nudge = TurnRunner._note_turn_for_memory_nudge
    forget_memory_nudge_counter = TurnRunner.forget_memory_nudge_counter


def _note(runner: _Runner, **overrides: Any) -> bool:
    kwargs: dict[str, Any] = {
        "agent_id": "main",
        "session_key": "s1",
        "input_mode": "user",
        "run_kind": "default",
        "no_memory_capture": False,
        "turn_segments": [],
        "prior_user_turns": None,
    }
    kwargs.update(overrides)
    return runner._note_turn_for_memory_nudge(**kwargs)


# -- counter arithmetic ----------------------------------------------------


def test_fires_on_the_interval_turn_and_not_before():
    r = _Runner(MemoryNudgeConfig(interval=3))
    assert [_note(r) for _ in range(3)] == [False, False, True]


def test_counter_restarts_after_firing():
    r = _Runner(MemoryNudgeConfig(interval=3))
    fired = [_note(r) for _ in range(9)]
    assert fired == [False, False, True] * 3


def test_interval_one_fires_every_turn():
    r = _Runner(MemoryNudgeConfig(interval=1))
    assert all(_note(r) for _ in range(4))


def test_sessions_count_independently():
    r = _Runner(MemoryNudgeConfig(interval=2))
    assert _note(r, session_key="a") is False
    assert _note(r, session_key="b") is False
    assert _note(r, session_key="a") is True
    assert _note(r, session_key="b") is True


def test_agents_count_independently():
    r = _Runner(MemoryNudgeConfig(interval=2))
    assert _note(r, agent_id="main") is False
    assert _note(r, agent_id="ops") is False
    assert _note(r, agent_id="main") is True


# -- disabled paths --------------------------------------------------------


def test_disabled_never_fires():
    r = _Runner(MemoryNudgeConfig(enabled=False, interval=1))
    assert not any(_note(r) for _ in range(5))


def test_zero_interval_disables():
    r = _Runner(MemoryNudgeConfig(interval=0))
    assert not any(_note(r) for _ in range(5))


def test_missing_config_never_fires():
    r = _Runner(None)
    assert not any(_note(r) for _ in range(5))


# -- traffic that must not advance the counter -----------------------------


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"input_mode": "system_event"}, id="system_event"),
        pytest.param({"no_memory_capture": True}, id="no_memory_capture"),
        pytest.param({"run_kind": "memory_nudge"}, id="the_review_itself"),
        pytest.param({"run_kind": "cron_turn"}, id="cron"),
        pytest.param({"run_kind": "heartbeat"}, id="heartbeat"),
        pytest.param({"run_kind": "subagent"}, id="subagent"),
    ],
)
def test_machine_traffic_never_fires(overrides: dict[str, Any]):
    """Machine turns say nothing durable about the user.

    Reviewing them would write the harness itself into memory.
    """
    r = _Runner(MemoryNudgeConfig(interval=1))
    assert not any(_note(r, **overrides) for _ in range(5))


def test_excluded_traffic_does_not_even_advance_the_counter():
    """Skipping must not merely suppress the fire -- it must not count.

    Otherwise a burst of cron turns silently consumes the user's interval and
    the next real turn nudges early.
    """
    r = _Runner(MemoryNudgeConfig(interval=3))
    for _ in range(10):
        _note(r, run_kind="cron_turn")
    assert [_note(r) for _ in range(3)] == [False, False, True]


def test_review_cannot_trigger_another_review():
    """The nudge's own run_kind is excluded, so reviews cannot recurse."""
    r = _Runner(MemoryNudgeConfig(interval=1))
    assert _note(r, run_kind="memory_nudge") is False
    assert r._memory_nudge_counters == {}


# -- self-directed writes reset the counter --------------------------------


@pytest.mark.parametrize("tool_name", ["memory", "memory_save"])
def test_agent_writing_memory_itself_resets_the_counter(tool_name: str):
    """An agent that curates unprompted does not need to be nudged."""
    r = _Runner(MemoryNudgeConfig(interval=3))
    _note(r)
    _note(r)
    assert _note(r, turn_segments=[{"type": "tool_result", "name": tool_name}]) is False
    # Counter restarted: the next fire is a full interval away.
    assert [_note(r) for _ in range(3)] == [False, False, True]


def test_unrelated_tool_calls_do_not_reset():
    r = _Runner(MemoryNudgeConfig(interval=2))
    _note(r)
    assert _note(r, turn_segments=[{"type": "tool_result", "name": "shell"}]) is True


def test_memory_search_is_not_a_write():
    """Reading memory is not curating it, so it must not reset the counter."""
    r = _Runner(MemoryNudgeConfig(interval=2))
    _note(r)
    assert _note(r, turn_segments=[{"type": "tool_result", "name": "memory_search"}]) is True


def test_malformed_segments_are_ignored():
    r = _Runner(MemoryNudgeConfig(interval=2))
    _note(r)
    assert _note(r, turn_segments=["not a dict", None, {}, {"name": None}]) is True


# -- eviction --------------------------------------------------------------


def test_forgetting_a_session_drops_its_counter():
    r = _Runner(MemoryNudgeConfig(interval=3))
    _note(r, session_key="a")
    _note(r, session_key="b")
    r.forget_memory_nudge_counter("a")
    assert [k[1] for k in r._memory_nudge_counters] == ["b"]


def test_forgetting_resets_progress_for_that_session():
    r = _Runner(MemoryNudgeConfig(interval=2))
    _note(r, session_key="a")
    r.forget_memory_nudge_counter("a")
    assert _note(r, session_key="a") is False


# -- hydration across processes --------------------------------------------


def test_counter_seeds_from_persisted_turns():
    """A rebuilt runner must not restart the session's count from zero.

    Every CLI invocation builds a fresh TurnRunner and the gateway evicts
    idle agents, so without seeding, a session spread across processes would
    never reach the interval and the nudge would never fire at all.
    """
    r = _Runner(MemoryNudgeConfig(interval=3))
    # 5 stored turns: 4 completed before this one, so phase is 4 % 3 == 1.
    # This turn makes 2 -> one more to go, instead of restarting at 1.
    assert _note(r, prior_user_turns=5) is False
    assert _note(r) is True


def test_hydration_can_fire_immediately_when_the_session_is_already_due():
    r = _Runner(MemoryNudgeConfig(interval=3))
    # 3 prior turns means 2 complete cycles' worth of phase -> due now.
    assert _note(r, prior_user_turns=3) is True


def test_hydration_only_seeds_once():
    """After seeding, the live counter owns the session."""
    r = _Runner(MemoryNudgeConfig(interval=5))
    _note(r, prior_user_turns=4)  # seed 3, this turn -> 4
    # A later turn reporting a wildly different count must not re-seed.
    assert _note(r, prior_user_turns=999) is True  # 5 == interval
    assert r._memory_nudge_counters[("main", "s1")] == 0


def test_unknown_prior_turns_starts_from_zero():
    r = _Runner(MemoryNudgeConfig(interval=2))
    assert _note(r, prior_user_turns=None) is False
    assert _note(r) is True


def test_hydration_ignores_nonsense_counts():
    r = _Runner(MemoryNudgeConfig(interval=2))
    assert _note(r, prior_user_turns=0) is False
    r.forget_memory_nudge_counter("s1")
    assert _note(r, prior_user_turns=-5) is False


# -- prompt ----------------------------------------------------------------


def test_review_prompt_offers_an_explicit_way_to_decline():
    """Without a stated opt-out a review invents an entry to justify itself."""
    from agentos.engine.runtime import _MEMORY_REVIEW_PROMPT

    assert "Nothing to save." in _MEMORY_REVIEW_PROMPT
    assert "memory tool" in _MEMORY_REVIEW_PROMPT
