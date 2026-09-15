"""Which connections belong to an agent.

Trading guardrails (the per-order approval threshold, the daily cap, the
human-only approve/reject/export) are only worth anything if the *gateway*
decides who is asking. Until now the client said ``initiator: manual`` or
``agent`` and was believed; an ``agentos trade swap`` run from an agent's
shell with the session variables unset became a human order.

This module computes an :class:`AgentBinding` for every admitted connection
from three signals, strongest first:

1. **The operator secret.** The desktop app spawns the gateway and hands it a
   random secret (through a 0600 file the gateway deletes after reading, so it
   never sits in the process environment). A connection that presents that
   secret at the handshake is the operator's and is never an agent's.
2. **An agent token.** When an agent turn spawns a shell, the shell tool mints
   a token here and passes it to the child as ``AGENTOS_AGENT_TOKEN``. The
   CLI presents it back; the connection is bound to that session and agent.
3. **An exec window.** While any agent shell is running, a new connection that
   presents nothing is treated as the agent's. That is what ``env -u`` gains:
   nothing. The window is the shell command's lifetime, including background
   processes it left behind. A human who opens the CLI in that window gets
   the agent's rules, which fail safe: their order waits for approval in the
   app instead of executing.

Nothing here is a full sandbox: a same-user process can still read the
user's files. It is the difference between a guardrail the prompt can talk
its way around and one it cannot.
"""

from __future__ import annotations

import contextlib
import hmac
import os
import secrets
import threading
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:
    from agentos.gateway.auth import AccessContext

log = structlog.get_logger(__name__)

AGENT_TOKEN_ENV = "AGENTOS_AGENT_TOKEN"
OPERATOR_SECRET_ENV = "AGENTOS_OPERATOR_SECRET"
OPERATOR_SECRET_FILE_ENV = "AGENTOS_OPERATOR_SECRET_FILE"

_MAX_TOKENS = 4096


@dataclass(frozen=True)
class AgentBinding:
    """Why a connection counts as an agent's, and for which chat."""

    via: str  # "token" | "window"
    session_key: str | None = None
    agent_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"via": self.via, "sessionKey": self.session_key, "agentId": self.agent_id}


class AgentSurface:
    """Process-wide registry of agent tokens, exec windows and the operator secret."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tokens: OrderedDict[str, AgentBinding] = OrderedDict()
        self._windows: dict[int, str | None] = {}
        self._next_window = 1
        self._operator_secret: str | None = None

    # ── operator ───────────────────────────────────────────────────────

    def set_operator_secret(self, secret: str | None) -> None:
        with self._lock:
            self._operator_secret = secret or None

    @property
    def has_operator_secret(self) -> bool:
        return self._operator_secret is not None

    def is_operator(self, presented: Any) -> bool:
        secret = self._operator_secret
        if not secret or not isinstance(presented, str) or not presented:
            return False
        return hmac.compare_digest(presented.encode(), secret.encode())

    def load_operator_secret_from_env(self, environ: dict[str, str] | None = None) -> bool:
        """Read the desktop's secret at boot and scrub every trace of it.

        The file form is preferred: it is deleted right after reading, so a
        child process cannot find it later. The bare variable form is removed
        from this process's environment for the same reason.
        """
        env = os.environ if environ is None else environ
        secret: str | None = None
        path = env.pop(OPERATOR_SECRET_FILE_ENV, None)
        if path:
            try:
                secret = Path(path).read_text(encoding="utf-8").strip() or None
            except OSError as exc:
                log.warning("agent_surface.operator_secret_unreadable", error=str(exc))
            with contextlib.suppress(OSError):
                Path(path).unlink()
        bare = env.pop(OPERATOR_SECRET_ENV, None)
        if secret is None and bare:
            secret = bare.strip() or None
        self.set_operator_secret(secret)
        if secret:
            log.info("agent_surface.operator_secret_loaded", source="file" if path else "env")
        return secret is not None

    # ── agent tokens ───────────────────────────────────────────────────

    def mint_token(self, session_key: str | None, agent_id: str | None) -> str:
        token = secrets.token_urlsafe(32)
        binding = AgentBinding(via="token", session_key=session_key or None, agent_id=agent_id)
        with self._lock:
            self._tokens[token] = binding
            while len(self._tokens) > _MAX_TOKENS:
                self._tokens.popitem(last=False)
        return token

    def resolve_token(self, presented: Any) -> AgentBinding | None:
        if not isinstance(presented, str) or not presented:
            return None
        with self._lock:
            # Constant-time over the candidate set: the token space is tiny
            # and a timing walk over a 43-char random string is not a real
            # risk, but there is no cost to doing it right.
            for token, binding in self._tokens.items():
                if hmac.compare_digest(token.encode(), presented.encode()):
                    return binding
        return None

    # ── exec windows ───────────────────────────────────────────────────

    def begin_window(self, session_key: str | None) -> int:
        with self._lock:
            handle = self._next_window
            self._next_window += 1
            self._windows[handle] = session_key or None
            return handle

    def end_window(self, handle: int) -> None:
        with self._lock:
            self._windows.pop(handle, None)

    @contextlib.contextmanager
    def exec_window(self, session_key: str | None) -> Iterator[None]:
        handle = self.begin_window(session_key)
        try:
            yield
        finally:
            self.end_window(handle)

    def active_windows(self) -> int:
        with self._lock:
            return len(self._windows)

    def _window_binding(self) -> AgentBinding | None:
        with self._lock:
            if not self._windows:
                return None
            keys = {k for k in self._windows.values() if k}
            session = next(iter(keys)) if len(keys) == 1 else None
            return AgentBinding(via="window", session_key=session)

    # ── admission ──────────────────────────────────────────────────────

    def bind(self, auth_params: dict[str, Any] | None) -> AgentBinding | None:
        """The binding for a connection presenting ``auth_params``, or None."""
        params = auth_params if isinstance(auth_params, dict) else {}
        if self.is_operator(params.get("operatorSecret")):
            return None
        token = self.resolve_token(params.get("agentToken"))
        if token is not None:
            return token
        return self._window_binding()

    def attach(self, access: AccessContext, auth_params: dict[str, Any] | None) -> AccessContext:
        binding = self.bind(auth_params)
        if binding is None:
            return access
        log.debug(
            "agent_surface.bound",
            via=binding.via,
            session_key=binding.session_key,
            agent_id=binding.agent_id,
        )
        return replace(access, agent=binding)

    def reset(self) -> None:
        with self._lock:
            self._tokens.clear()
            self._windows.clear()
            self._operator_secret = None


_surface = AgentSurface()


def get_agent_surface() -> AgentSurface:
    return _surface


def agent_binding(ctx: Any) -> AgentBinding | None:
    """The binding on an RPC context, tolerant of test doubles."""
    access = getattr(ctx, "access", None)
    binding = getattr(access, "agent", None)
    return binding if isinstance(binding, AgentBinding) else None


__all__ = [
    "AGENT_TOKEN_ENV",
    "OPERATOR_SECRET_ENV",
    "OPERATOR_SECRET_FILE_ENV",
    "AgentBinding",
    "AgentSurface",
    "agent_binding",
    "get_agent_surface",
]
