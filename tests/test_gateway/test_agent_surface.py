"""The gateway, not the client, decides which connections are an agent's."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from agentos.gateway.access import ConnectionSurface
from agentos.gateway.agent_surface import (
    AGENT_TOKEN_ENV,
    OPERATOR_SECRET_ENV,
    OPERATOR_SECRET_FILE_ENV,
    AgentBinding,
    AgentSurface,
    agent_binding,
)
from agentos.gateway.auth import AccessContext
from agentos.gateway.rpc import RpcContext


@pytest.fixture
def surface() -> AgentSurface:
    return AgentSurface()


def _access() -> AccessContext:
    return AccessContext(surface=ConnectionSurface.CONTROL, admitted=True, credential_verified=True)


class TestTokens:
    def test_minted_token_binds_to_the_session(self, surface: AgentSurface) -> None:
        token = surface.mint_token("agent:trading:webchat:x", "trading")
        binding = surface.bind({"agentToken": token})
        assert binding == AgentBinding(
            via="token", session_key="agent:trading:webchat:x", agent_id="trading"
        )

    def test_unknown_token_is_not_a_binding(self, surface: AgentSurface) -> None:
        assert surface.resolve_token("nope") is None
        assert surface.resolve_token(None) is None
        assert surface.bind({"agentToken": "nope"}) is None

    def test_tokens_are_bounded(self, surface: AgentSurface) -> None:
        first = surface.mint_token("s0", "a")
        for i in range(5000):
            surface.mint_token(f"s{i}", "a")
        assert surface.resolve_token(first) is None


class TestWindows:
    def test_new_connection_during_a_shell_is_the_agents(self, surface: AgentSurface) -> None:
        assert surface.bind({}) is None
        with surface.exec_window("agent:main:chat"):
            assert surface.active_windows() == 1
            assert surface.bind({}) == AgentBinding(via="window", session_key="agent:main:chat")
            # Dropping the token gains nothing: still the agent's.
            assert surface.bind({"agentToken": "stripped"}).via == "window"
        assert surface.active_windows() == 0
        assert surface.bind({}) is None

    def test_two_sessions_at_once_bind_without_a_session(self, surface: AgentSurface) -> None:
        a = surface.begin_window("agent:a")
        b = surface.begin_window("agent:b")
        assert surface.bind({}) == AgentBinding(via="window", session_key=None)
        surface.end_window(a)
        assert surface.bind({}).session_key == "agent:b"
        surface.end_window(b)

    def test_token_beats_window_for_attribution(self, surface: AgentSurface) -> None:
        token = surface.mint_token("agent:x", "trading")
        with surface.exec_window("agent:y"):
            assert surface.bind({"agentToken": token}).session_key == "agent:x"


class TestOperator:
    def test_operator_secret_is_never_an_agent(self, surface: AgentSurface) -> None:
        surface.set_operator_secret("s3cret")
        with surface.exec_window("agent:x"):
            assert surface.bind({"operatorSecret": "s3cret"}) is None
            assert surface.bind({"operatorSecret": "wrong"}) is not None
            assert surface.bind({}) is not None

    def test_no_secret_configured_admits_nobody_as_operator_by_secret(
        self, surface: AgentSurface
    ) -> None:
        assert surface.is_operator("anything") is False
        assert surface.has_operator_secret is False

    def test_secret_file_is_read_once_and_deleted(
        self, surface: AgentSurface, tmp_path: Path
    ) -> None:
        secret_file = tmp_path / "operator.secret"
        secret_file.write_text("from-file\n")
        env = {OPERATOR_SECRET_FILE_ENV: str(secret_file), "OTHER": "kept"}
        assert surface.load_operator_secret_from_env(env) is True
        assert surface.is_operator("from-file")
        assert not secret_file.exists()
        # Scrubbed: a child of this process cannot find it again.
        assert OPERATOR_SECRET_FILE_ENV not in env and env == {"OTHER": "kept"}

    def test_bare_env_secret_is_scrubbed(self, surface: AgentSurface) -> None:
        env = {OPERATOR_SECRET_ENV: "bare"}
        assert surface.load_operator_secret_from_env(env) is True
        assert surface.is_operator("bare") and env == {}

    def test_missing_file_is_not_fatal(self, surface: AgentSurface, tmp_path: Path) -> None:
        env = {OPERATOR_SECRET_FILE_ENV: str(tmp_path / "gone")}
        assert surface.load_operator_secret_from_env(env) is False
        assert surface.has_operator_secret is False


class TestAttach:
    def test_attach_marks_the_access_context(self, surface: AgentSurface) -> None:
        token = surface.mint_token("agent:x", "trading")
        access = surface.attach(_access(), {"agentToken": token})
        assert access.agent is not None and access.agent.session_key == "agent:x"
        assert access.admitted is True
        ctx = RpcContext(conn_id="c", access=access)
        assert agent_binding(ctx) == access.agent

    def test_unbound_access_is_left_alone(self, surface: AgentSurface) -> None:
        access = _access()
        assert surface.attach(access, {}) is access
        assert agent_binding(RpcContext(conn_id="c", access=access)) is None
        assert agent_binding(object()) is None


def test_env_names_are_the_documented_ones() -> None:
    assert AGENT_TOKEN_ENV == "AGENTOS_AGENT_TOKEN"
    assert OPERATOR_SECRET_ENV == "AGENTOS_OPERATOR_SECRET"
    assert os.environ.get(OPERATOR_SECRET_ENV) is None
