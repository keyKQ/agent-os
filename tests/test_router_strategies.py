"""Registry contract tests — the single source of truth for strategy metadata.

Every backend surface (dispatch, cache key, boot, doctor, mutations, CLI,
RoutingSource) consults this registry instead of comparing against literal
strategy ids, so these tests pin the values those surfaces depend on.
"""

from __future__ import annotations

from pathlib import Path

from agentos.agentos_router.pilot.features import MINILM_MODEL_ID
from agentos.agentos_router.pilot.strategy import (
    SOURCE_HEALTHY,
    SOURCE_UNAVAILABLE,
)
from agentos.router_strategies import (
    LLM_JUDGE_STRATEGY_ID,
    PILOT_STRATEGY_ID,
    V4_STRATEGY_ID,
    RouterStrategyInfo,
    get_strategy_info,
    is_known_strategy,
    known_strategy_ids,
    pilot_asset_probe,
    resolve_strategy_id,
)
from agentos.router_tiers import DEFAULT_ROUTER_STRATEGY


def test_registry_knows_all_three_strategies() -> None:
    assert known_strategy_ids() == {
        V4_STRATEGY_ID,
        LLM_JUDGE_STRATEGY_ID,
        PILOT_STRATEGY_ID,
    }
    assert is_known_strategy("pilot-v1")
    assert not is_known_strategy("nope")


def test_pilot_registry_entry_matches_strategy_source_tags() -> None:
    info = get_strategy_info(PILOT_STRATEGY_ID)
    assert isinstance(info, RouterStrategyInfo)
    # The registry telemetry tags must match the strategy's own constants.
    assert info.source == SOURCE_HEALTHY == "pilot_v1"
    assert info.degraded_source == SOURCE_UNAVAILABLE == "pilot_unavailable"
    assert info.requires_local_assets is True
    assert info.uses_judge is False
    assert info.asset_probe is pilot_asset_probe


def test_v4_and_judge_registry_entries() -> None:
    v4 = get_strategy_info(V4_STRATEGY_ID)
    assert v4 is not None
    assert v4.requires_local_assets is True
    assert v4.uses_judge is False
    assert v4.asset_probe is not None

    judge = get_strategy_info(LLM_JUDGE_STRATEGY_ID)
    assert judge is not None
    assert judge.requires_local_assets is False
    assert judge.uses_judge is True
    assert judge.asset_probe is None


def test_registry_minilm_id_tracks_feature_builder() -> None:
    # The Pilot probe checks the MiniLM dir; its id must track the feature
    # builder's pinned model id so the probe never drifts.
    from agentos import router_strategies

    assert router_strategies._MINILM_MODEL_ID == MINILM_MODEL_ID


def test_resolve_strategy_id_falls_back_to_default() -> None:
    assert resolve_strategy_id("pilot-v1") == "pilot-v1"
    assert resolve_strategy_id("v4_phase3") == "v4_phase3"
    assert resolve_strategy_id("bogus") == DEFAULT_ROUTER_STRATEGY
    assert resolve_strategy_id(None) == DEFAULT_ROUTER_STRATEGY
    assert resolve_strategy_id("") == DEFAULT_ROUTER_STRATEGY


def test_pilot_asset_probe_reports_missing_bundle(tmp_path: Path) -> None:
    # Point at an empty dir: both bundle files must be reported missing.
    cfg = type("Cfg", (), {"pilot_artifact_dir": str(tmp_path / "absent")})()
    missing = pilot_asset_probe(cfg)
    assert any("model.onnx" in m for m in missing)
    assert any("manifest.json" in m for m in missing)


def test_pilot_asset_probe_passes_for_fixture_bundle() -> None:
    # The committed fixture bundle satisfies the file checks; the MiniLM dir is
    # bundled too, so a healthy tree yields no missing pilot bundle files.
    fixture = (
        Path(__file__).parent
        / "test_agentos_router"
        / "data"
        / "pilot_fixture"
    )
    cfg = type("Cfg", (), {"pilot_artifact_dir": str(fixture)})()
    missing = pilot_asset_probe(cfg)
    # No bundle file should be missing (MiniLM presence depends on the checkout;
    # assert only on the bundle-file portion).
    assert not [m for m in missing if "model.onnx" in m or "manifest.json" in m]
