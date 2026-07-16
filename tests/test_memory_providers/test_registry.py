"""Tests for the memory-provider registry (Task B3).

Offline and deterministic: no ``mem0ai``, no network. The mem0 factory path
is exercised both TODAY (its provider module does not exist yet, so the lazy
import raises ImportError) and via monkeypatch to simulate the future
"module exists but raises ImportError" and "constructs successfully" paths.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from agentos.memory.providers import registry
from agentos.memory.providers.base import MemoryProvider
from agentos.memory.providers.registry import create_provider


class _FakeProvider(MemoryProvider):
    """Minimal available provider for the success-path test."""

    def __init__(self, **kwargs: Any) -> None:
        self._kwargs = kwargs

    @property
    def name(self) -> str:
        return "mem0"

    def is_available(self) -> bool:
        return True

    async def initialize(self, session_id: str, **kwargs: Any) -> None:  # pragma: no cover
        return None


def test_create_provider_unknown_name_returns_none() -> None:
    result = create_provider(
        "nope-not-a-provider",
        memory_config=None,
        agent_state_dir=Path("/tmp/agent"),
    )
    assert result is None


def test_create_provider_mem0_module_missing_returns_none() -> None:
    """TODAY's path: ``mem0_provider`` module does not exist yet.

    The lazy import in ``_make_mem0`` raises ImportError, which the registry
    routes to the actionable-warning path and returns None. This must hold
    with no monkeypatching so B3 is shippable before B5.
    """
    assert "agentos.memory.providers.mem0_provider" not in sys.modules
    result = create_provider(
        "mem0",
        memory_config=object(),
        agent_state_dir=Path("/tmp/agent"),
    )
    assert result is None


def test_create_provider_mem0_import_error_from_factory(monkeypatch: Any) -> None:
    """Future path: provider module exists but its dependency is missing."""

    def _raising_factory(*, memory_config: Any, agent_state_dir: Path) -> MemoryProvider:
        raise ImportError("No module named 'mem0ai'")

    monkeypatch.setitem(registry._FACTORIES, "mem0", _raising_factory)
    result = create_provider(
        "mem0",
        memory_config=object(),
        agent_state_dir=Path("/tmp/agent"),
    )
    assert result is None


def test_create_provider_generic_error_returns_none(monkeypatch: Any) -> None:
    """A non-ImportError construction failure also degrades to None."""

    def _raising_factory(*, memory_config: Any, agent_state_dir: Path) -> MemoryProvider:
        raise RuntimeError("boom")

    monkeypatch.setitem(registry._FACTORIES, "mem0", _raising_factory)
    result = create_provider(
        "mem0",
        memory_config=object(),
        agent_state_dir=Path("/tmp/agent"),
    )
    assert result is None


def test_create_provider_success_path(monkeypatch: Any) -> None:
    """A working factory returns the constructed provider."""

    def _ok_factory(*, memory_config: Any, agent_state_dir: Path) -> MemoryProvider:
        return _FakeProvider(memory_config=memory_config, agent_state_dir=agent_state_dir)

    monkeypatch.setitem(registry._FACTORIES, "mem0", _ok_factory)
    result = create_provider(
        "mem0",
        memory_config=object(),
        agent_state_dir=Path("/tmp/agent"),
    )
    assert isinstance(result, _FakeProvider)
