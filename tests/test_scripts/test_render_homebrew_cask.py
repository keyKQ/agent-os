from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "render_homebrew_cask.py"
REPO_ROOT = SCRIPT_PATH.parents[1]
TEMPLATE_PATH = REPO_ROOT / "packaging" / "homebrew" / "agentos.rb"
TAURI_CONF_PATH = REPO_ROOT / "desktop" / "src-tauri" / "tauri.conf.json"
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "desktop-release.yml"


def load_script():
    spec = importlib.util.spec_from_file_location("render_homebrew_cask", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def write_dmg(directory: Path, name: str, payload: bytes) -> str:
    (directory / name).write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


def make_release(directory: Path, version: str = "2026.8.24") -> dict[str, str]:
    return {
        "aarch64": write_dmg(directory, f"AgentOS_{version}_aarch64.dmg", b"arm bytes"),
        "x64": write_dmg(directory, f"AgentOS_{version}_x64.dmg", b"intel bytes"),
    }


def test_renders_both_checksums_and_the_tag(tmp_path: Path) -> None:
    script = load_script()
    digests = make_release(tmp_path)

    cask = script.build_cask(tag="v2026.8.24", dmg_dir=tmp_path, template_path=TEMPLATE_PATH)

    assert 'version "2026.8.24"' in cask
    assert f'arm:   "{digests["aarch64"]}"' in cask
    assert f'intel: "{digests["x64"]}"' in cask
    assert "/releases/download/v2026.8.24/AgentOS_#{version}_#{arch}.dmg" in cask
    assert "__" not in cask


def test_ignores_other_platforms_assets_sharing_the_directory(tmp_path: Path) -> None:
    script = load_script()
    make_release(tmp_path)
    (tmp_path / "AgentOS_2026.8.24_amd64.AppImage").write_bytes(b"linux")
    (tmp_path / "AgentOS_2026.8.24_x64-setup.exe").write_bytes(b"windows")

    cask = script.build_cask(tag="v2026.8.24", dmg_dir=tmp_path, template_path=TEMPLATE_PATH)

    assert 'version "2026.8.24"' in cask


def test_rejects_a_release_missing_one_architecture(tmp_path: Path) -> None:
    script = load_script()
    write_dmg(tmp_path, "AgentOS_2026.8.24_aarch64.dmg", b"arm bytes")

    with pytest.raises(script.RenderError, match="no DMG for x64"):
        script.build_cask(tag="v2026.8.24", dmg_dir=tmp_path, template_path=TEMPLATE_PATH)


def test_rejects_dmgs_from_two_different_builds(tmp_path: Path) -> None:
    script = load_script()
    write_dmg(tmp_path, "AgentOS_2026.8.24_aarch64.dmg", b"arm bytes")
    write_dmg(tmp_path, "AgentOS_2026.8.23_x64.dmg", b"intel bytes")

    with pytest.raises(script.RenderError, match="disagree on the version"):
        script.build_cask(tag="v2026.8.24", dmg_dir=tmp_path, template_path=TEMPLATE_PATH)


def test_rejects_a_tag_that_does_not_match_the_artifacts(tmp_path: Path) -> None:
    script = load_script()
    make_release(tmp_path, version="2026.8.23")

    with pytest.raises(script.RenderError, match="different releases"):
        script.build_cask(tag="v2026.8.24", dmg_dir=tmp_path, template_path=TEMPLATE_PATH)


@pytest.mark.parametrize(
    ("tag", "dmg_version"),
    [
        ("v2026.8.24", "2026.8.24"),
        ("v2026.8.24rc1", "2026.8.24-rc1"),
        ("v2026.8.24.post1", "2026.8.24+post1"),
    ],
)
def test_accepts_every_spelling_the_release_cut_produces(
    tmp_path: Path, tag: str, dmg_version: str
) -> None:
    """AGENTS.md fixes how a PEP 440 release is spelled in the desktop files."""
    script = load_script()
    make_release(tmp_path, version=dmg_version)

    cask = script.build_cask(tag=tag, dmg_dir=tmp_path, template_path=TEMPLATE_PATH)

    assert f'version "{dmg_version}"' in cask
    assert f"/releases/download/{tag}/" in cask


def test_unfilled_placeholder_fails_instead_of_shipping(tmp_path: Path) -> None:
    script = load_script()
    template = tmp_path / "agentos.rb"
    template.write_text('version "__VERSION__"\nurl "__RELEASE_URL__"\n', encoding="utf-8")
    make_release(tmp_path)

    with pytest.raises(script.RenderError, match=r"__RELEASE_URL__"):
        script.build_cask(tag="v2026.8.24", dmg_dir=tmp_path, template_path=template)


def test_zap_leaves_the_shared_agentos_home_alone() -> None:
    """`~/.agentos` is the CLI's home too; uninstalling the app must not take it."""
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    zap = template.split("zap trash:", 1)[1]

    assert "~/.agentos" not in zap


def test_template_tracks_the_tauri_bundle_identifier_and_floor() -> None:
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    config = json.loads(TAURI_CONF_PATH.read_text(encoding="utf-8"))

    assert config["identifier"] in template
    # The cask spells the floor as a Homebrew symbol, so the two only stay in
    # step if a bump to minimumSystemVersion is noticed here.
    assert config["bundle"]["macOS"]["minimumSystemVersion"] == "11.0"
    assert "depends_on macos: :big_sur" in template


def test_release_workflow_publishes_the_committed_template() -> None:
    workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

    assert "scripts/render_homebrew_cask.py" in workflow
    assert "use-agent-os/homebrew-agentos" in workflow
    # The push has to wait for the assets the cask's URLs point at.
    assert "needs: release" in workflow
    # This repository cannot serve as its own tap: `brew tap` clones with git
    # LFS filters active but no `git-lfs` on its scrubbed PATH, so the clone
    # hard-fails on any machine that ever ran `git lfs install`. The cask has
    # to live in a separate, LFS-free repository.
    assert "HOMEBREW_TAP_TOKEN" in workflow
