from __future__ import annotations

import tomllib
from pathlib import Path

CURRENT_VERSION = "2026.8.28"
CURRENT_TAG = f"v{CURRENT_VERSION}"
PREVIEW_VERSION = "0.0.1rc1"
PREVIEW_TAG = f"v{PREVIEW_VERSION}"


def test_pyproject_version_matches_current_release() -> None:
    config = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    version = config["project"]["version"]
    assert version == CURRENT_VERSION, (
        f"pyproject.toml version must match the current release; got '{version}'"
    )


def test_lockfile_version_matches_current_release() -> None:
    lock = tomllib.loads(Path("uv.lock").read_text(encoding="utf-8"))
    package = next(item for item in lock["package"] if item["name"] == "use-agent-os")

    assert package["version"] == CURRENT_VERSION


def _dep_names(specs: list[str]) -> set[str]:
    names: set[str] = set()
    for spec in specs:
        head = spec.strip()
        for sep in ("[", " ", ";", "=", ">", "<", "~", "!"):
            head = head.split(sep, 1)[0]
        if head:
            names.add(head.lower())
    return names


def test_recommended_extra_uses_onnx_tokenizers_without_transformers() -> None:
    config = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    recommended = config["project"]["optional-dependencies"]["recommended"]

    assert any(dep.startswith("onnxruntime") for dep in recommended)
    assert any(dep.startswith("tokenizers") for dep in recommended)
    assert not any(dep.startswith("transformers") for dep in recommended)


def test_default_recommended_install_contract_covers_embedding_and_channels() -> None:
    config = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    project = config["project"]
    dependencies = _dep_names(project["dependencies"])
    extras = project["optional-dependencies"]
    recommended = _dep_names(extras["recommended"])

    # Local memory embedding (BGE ONNX) and the default pilot-v1 router both
    # run on numpy + onnxruntime + tokenizers; recommended bundles them so the
    # default router works. The v4-era lightgbm/joblib/scikit-learn deps left
    # with the removed v4_phase3 engine and must NOT creep back in.
    assert {
        "numpy",
        "onnxruntime",
        "tokenizers",
    } <= recommended
    assert not {"lightgbm", "scikit-learn", "joblib"} & recommended
    assert {
        "httpx",  # Slack and Telegram HTTP calls
        "python-telegram-bot",
        "websockets",  # Discord gateway transport
    } <= dependencies
    assert not {"cryptography", "dingtalk-stream", "matrix-nio", "qq-botpy"} & dependencies
    for alias in (
        "dingtalk",
        "discord",
        "matrix",
        "matrix-e2e",
        "qq",
        "slack",
        "telegram",
        "wecom",
    ):
        assert alias not in extras


def test_core_dependencies_support_default_pptx_skill() -> None:
    config = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    dependencies = config["project"]["dependencies"]

    assert any(dep.startswith("python-pptx") for dep in dependencies)


def test_releases_md_exists_and_references_current_and_preview_tags() -> None:
    releases = Path("RELEASES.md")
    assert releases.is_file(), "RELEASES.md must exist at the repository root"
    text = releases.read_text(encoding="utf-8")
    assert CURRENT_TAG in text, f"RELEASES.md must reference the tag '{CURRENT_TAG}'"
    assert PREVIEW_TAG in text, f"RELEASES.md must reference the tag '{PREVIEW_TAG}'"


def test_changelog_has_current_release_section_and_unreleased() -> None:
    changelog = Path("CHANGELOG.md")
    assert changelog.is_file(), "CHANGELOG.md must exist at the repository root"
    text = changelog.read_text(encoding="utf-8")
    assert (
        f"[{CURRENT_VERSION}]" in text
    ), f"CHANGELOG.md must contain a [{CURRENT_VERSION}] section"
    assert "[Unreleased]" in text, "CHANGELOG.md must retain an [Unreleased] section"


def test_readme_release_install_uses_latest_assets_and_pinned_alternative() -> None:
    readme = Path("README.md").read_text(encoding="utf-8")

    assert (
        "releases/latest/download/AgentOS-windows-x64-portable.zip"
        in readme
    )
    assert (
        f"releases/download/{CURRENT_TAG}/use_agent_os-{CURRENT_VERSION}-py3-none-any.whl"
        in readme
    )
    assert "use_agent_os-latest-py3-none-any.whl" not in readme
    assert "Python wheel installs use versioned wheel filenames" in readme
    assert "Release install commands use published GitHub release assets" in readme


def test_release_installers_default_to_current_tag() -> None:
    for path in [Path("install.sh"), Path("install.ps1")]:
        text = path.read_text(encoding="utf-8")
        assert CURRENT_TAG in text
        assert "use_agent_os-$releaseVersion-py3-none-any.whl" in text or (
            "use_agent_os-${release_version}-py3-none-any.whl" in text
        )
        assert "use_agent_os-latest-py3-none-any.whl" not in text


def test_release_workflow_marks_preview_tags_as_prereleases() -> None:
    workflow = Path(".github/workflows/wheelhouse-release.yml").read_text(encoding="utf-8")

    assert "IS_PRERELEASE" in workflow
    assert "--prerelease" in workflow
    assert "AgentOS {match.group(1)} Preview {match.group(2)}" in workflow
    assert "is_prerelease = bool(re.search" in workflow
    assert "if not is_prerelease:" in workflow
    assert "expected.add(\"AgentOS-windows-x64-portable.zip\")" in workflow
    assert "use_agent_os-latest-py3-none-any.whl" not in workflow


# --- desktop app ------------------------------------------------------------
#
# The Tauri shell carries its own version in two files Cargo and the bundler
# read independently of pyproject.toml. A desktop build whose version drifts
# from the wheel it bundles reports the wrong version in About, in the updater's
# comparison, and in the installer's upgrade logic — none of which fail loudly.

DESKTOP_ROOT = Path("desktop/src-tauri")


def cargo_version(project_version: str) -> str:
    """Translate an AgentOS CalVer into the semver Cargo and Tauri accept.

    A release like ``2026.8.24`` is already valid semver. A preview like
    ``2026.8.24rc1`` is not — PEP 440 glues the pre-release marker onto the
    patch component, while semver requires it after a hyphen. ``.postN`` has no
    semver equivalent that orders correctly, so it becomes build metadata.
    """

    import re

    match = re.fullmatch(
        r"(\d+\.\d+\.\d+)(?:((?:a|b|rc)\d+)|\.post(\d+))?", project_version
    )
    assert match, f"unsupported version shape for the desktop bundle: {project_version}"
    core, pre, post = match.groups()
    if pre:
        return f"{core}-{pre}"
    if post:
        return f"{core}+post{post}"
    return core


def test_cargo_version_translates_pep440_versions() -> None:
    assert cargo_version("2026.8.24") == "2026.8.24"
    assert cargo_version("0.0.1rc1") == "0.0.1-rc1"
    assert cargo_version("2026.8.24.post1") == "2026.8.24+post1"


def test_release_bump_script_agrees_on_the_desktop_version() -> None:
    """The release script must translate versions exactly as this test does.

    They are separate implementations in separate trees, and a disagreement
    surfaces as a bump that writes a desktop version this file then rejects —
    at which point the release is already half-applied.
    """

    import importlib.util

    script = Path(".claude/skills/pump-version/scripts/pump_version.py")
    if not script.is_file():
        import pytest

        pytest.skip("release bump skill is not present in this checkout")

    spec = importlib.util.spec_from_file_location("pump_version", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    for candidate in (CURRENT_VERSION, PREVIEW_VERSION, "2026.8.24.post1"):
        assert module.cargo_version(candidate) == cargo_version(candidate)


def test_desktop_cargo_version_matches_current_release() -> None:
    manifest = tomllib.loads((DESKTOP_ROOT / "Cargo.toml").read_text(encoding="utf-8"))
    version = manifest["package"]["version"]
    assert version == cargo_version(CURRENT_VERSION), (
        f"desktop/src-tauri/Cargo.toml version must track the release; got '{version}'"
    )


def test_desktop_tauri_config_version_matches_current_release() -> None:
    import json

    config = json.loads((DESKTOP_ROOT / "tauri.conf.json").read_text(encoding="utf-8"))
    version = config["version"]
    assert version == cargo_version(CURRENT_VERSION), (
        f"desktop/src-tauri/tauri.conf.json version must track the release; got '{version}'"
    )


def test_desktop_bundle_ships_the_runtime_resources() -> None:
    import json

    config = json.loads((DESKTOP_ROOT / "tauri.conf.json").read_text(encoding="utf-8"))
    resources = config["bundle"]["resources"]
    assert any("resources/" in entry for entry in resources), (
        "the desktop bundle must ship its runtime resources or the app cannot start"
    )
