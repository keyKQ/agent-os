"""Config fields for the curated memory store."""

from agentos.gateway.config import GatewayConfig


def test_memory_config_has_curated_char_limits_with_defaults() -> None:
    cfg = GatewayConfig()
    assert cfg.memory.curated_memory_char_limit == 4000
    assert cfg.memory.curated_user_char_limit == 2000


def test_curated_char_limits_are_overridable() -> None:
    cfg = GatewayConfig(
        memory={"curated_memory_char_limit": 1000, "curated_user_char_limit": 500}
    )
    assert cfg.memory.curated_memory_char_limit == 1000
    assert cfg.memory.curated_user_char_limit == 500
