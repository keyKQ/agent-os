"""Contract tests for the desktop app's bundled-runtime builder.

Two things are pinned here. First, the layout logic: the builder is the only
place that knows a Windows `install_only` tree spells its interpreter
`python.exe` next to `Lib/site-packages` while macOS and Linux use
`bin/python3.12` next to `lib/python3.12/site-packages`, and getting it wrong
produces an app bundle that fails at launch on one platform only.

Second, the manifest contract with the Rust shell. `runtime.json` is the sole
interface between this script and `desktop/src-tauri/src/runtime.rs`, and the
two are written in different languages with no shared schema, so the tests read
the Rust source and assert the field names and schema version still line up.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "build_desktop_runtime.py"
REPO_ROOT = SCRIPT_PATH.parents[1]
RUST_RUNTIME = REPO_ROOT / "desktop" / "src-tauri" / "src" / "runtime.rs"


def load_script():
    spec = importlib.util.spec_from_file_location("build_desktop_runtime", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def module():
    return load_script()


def build_runtime_tree(module, root: Path, *, agentos_version: str = "2026.8.24") -> Path:
    """Lay down the minimum tree `verify_desktop_runtime` accepts."""

    layout = module.runtime_layout("macos-arm64", "3.12.13")
    runtime_root = root / "runtime" / "python"
    interpreter = layout.python_exe_path(runtime_root)
    interpreter.parent.mkdir(parents=True)
    interpreter.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    interpreter.chmod(0o755)

    site_packages = layout.site_packages_path(runtime_root)
    control_ui = site_packages / "agentos" / "gateway" / "static" / "dist"
    control_ui.mkdir(parents=True)
    (control_ui / "index.html").write_text("<!doctype html>", encoding="utf-8")
    cli = site_packages / "agentos" / "cli"
    cli.mkdir(parents=True)
    (cli / "main.py").write_text("", encoding="utf-8")

    module.write_manifest(
        root,
        module.build_manifest(
            agentos_version=agentos_version,
            platform_tag="macos-arm64",
            python_version="3.12.13",
            runtime_release="20260414",
            profile="recommended",
            layout=layout,
        ),
    )
    return root


# --- layout ---------------------------------------------------------------


def test_windows_layout_uses_the_unversioned_spelling(module) -> None:
    layout = module.runtime_layout("windows-x64", "3.12.13")
    assert layout.python_exe == "python.exe"
    assert layout.site_packages == "Lib/site-packages"


@pytest.mark.parametrize("platform_tag", ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64"])
def test_posix_layouts_are_versioned(module, platform_tag: str) -> None:
    layout = module.runtime_layout(platform_tag, "3.12.13")
    assert layout.python_exe == "bin/python3.12"
    assert layout.site_packages == "lib/python3.12/site-packages"


def test_layout_uses_major_minor_not_the_patch(module) -> None:
    # python-build-standalone names the directory by feature release, so a
    # patch bump must not move the bundled site-packages path.
    assert module.runtime_layout("linux-x64", "3.12.9").site_packages.endswith(
        "python3.12/site-packages"
    )


def test_layout_rejects_an_unusable_version(module) -> None:
    with pytest.raises(SystemExit):
        module.runtime_layout("linux-x64", "3")


def test_layout_paths_use_forward_slashes(module) -> None:
    # The manifest must stay byte-identical across build hosts, and Rust joins
    # these onto a PathBuf, which accepts `/` on every platform.
    for platform_tag in ("windows-x64", "macos-arm64"):
        layout = module.runtime_layout(platform_tag, "3.12.13")
        assert "\\" not in layout.python_exe
        assert "\\" not in layout.site_packages


# --- launch contract ------------------------------------------------------


def test_gateway_argv_invokes_the_cli_as_a_module(module) -> None:
    layout = module.runtime_layout("macos-arm64", "3.12.13")
    argv = module.gateway_argv(layout, host="127.0.0.1", port=18791)

    # Console scripts are not unpacked into the bundled runtime, so `-m` is the
    # only entry point that exists.
    assert argv[:3] == ["bin/python3.12", "-m", "agentos.cli.main"]
    assert argv[3:] == ["gateway", "run", "--bind", "127.0.0.1", "--port", "18791"]


# --- manifest -------------------------------------------------------------


def test_manifest_is_reproducible(module) -> None:
    layout = module.runtime_layout("linux-x64", "3.12.13")
    kwargs = dict(
        agentos_version="2026.8.24",
        platform_tag="linux-x64",
        python_version="3.12.13",
        runtime_release="20260414",
        profile="recommended",
        layout=layout,
    )
    assert module.build_manifest(**kwargs) == module.build_manifest(**kwargs)


def test_manifest_carries_no_host_identifying_values(module) -> None:
    # The manifest ships to users inside the app bundle.
    manifest = module.build_manifest(
        agentos_version="2026.8.24",
        platform_tag="linux-x64",
        python_version="3.12.13",
        runtime_release="20260414",
        profile="recommended",
        layout=module.runtime_layout("linux-x64", "3.12.13"),
    )
    rendered = json.dumps(manifest)
    assert "/Users/" not in rendered
    assert "/home/" not in rendered
    assert not any(key in manifest for key in ("built_at", "hostname", "path"))


def test_manifest_schema_version_matches_the_rust_shell(module) -> None:
    source = RUST_RUNTIME.read_text(encoding="utf-8")
    match = re.search(r"MANIFEST_SCHEMA_VERSION:\s*u32\s*=\s*(\d+)", source)
    assert match, "desktop/src-tauri/src/runtime.rs must declare MANIFEST_SCHEMA_VERSION"
    assert int(match.group(1)) == module.MANIFEST_SCHEMA_VERSION


def test_manifest_fields_match_what_the_rust_shell_deserializes(module) -> None:
    source = RUST_RUNTIME.read_text(encoding="utf-8")
    struct = re.search(r"pub struct RuntimeManifest \{(.*?)\n\}", source, re.DOTALL)
    assert struct, "desktop/src-tauri/src/runtime.rs must declare RuntimeManifest"
    rust_fields = set(re.findall(r"pub (\w+):", struct.group(1)))

    manifest = module.build_manifest(
        agentos_version="2026.8.24",
        platform_tag="linux-x64",
        python_version="3.12.13",
        runtime_release="20260414",
        profile="recommended",
        layout=module.runtime_layout("linux-x64", "3.12.13"),
    )

    # serde has no default for these, so a field the builder stops emitting is
    # a hard deserialization failure at app launch.
    missing = rust_fields - set(manifest)
    assert not missing, f"runtime.json is missing fields Rust requires: {sorted(missing)}"


# --- verification ---------------------------------------------------------


def test_verify_accepts_a_complete_tree(module, tmp_path: Path) -> None:
    root = build_runtime_tree(module, tmp_path)
    module.verify_desktop_runtime(root, run_import_probe=False)


def test_verify_rejects_a_missing_manifest(module, tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="manifest is missing"):
        module.verify_desktop_runtime(tmp_path, run_import_probe=False)


def test_verify_rejects_a_missing_interpreter(module, tmp_path: Path) -> None:
    root = build_runtime_tree(module, tmp_path)
    (root / "runtime" / "python" / "bin" / "python3.12").unlink()
    with pytest.raises(SystemExit, match="interpreter is missing"):
        module.verify_desktop_runtime(root, run_import_probe=False)


def test_verify_rejects_a_runtime_without_agentos(module, tmp_path: Path) -> None:
    root = build_runtime_tree(module, tmp_path)
    layout = module.runtime_layout("macos-arm64", "3.12.13")
    site_packages = layout.site_packages_path(root / "runtime" / "python")
    (site_packages / "agentos" / "cli" / "main.py").unlink()
    with pytest.raises(SystemExit, match="not installed into the bundled runtime"):
        module.verify_desktop_runtime(root, run_import_probe=False)


def test_verify_rejects_a_runtime_without_the_control_ui(module, tmp_path: Path) -> None:
    # A gateway with no Control UI bundle answers /health and then serves a 503
    # for every navigation, which in a desktop window reads as a broken app.
    root = build_runtime_tree(module, tmp_path)
    layout = module.runtime_layout("macos-arm64", "3.12.13")
    index = (
        layout.site_packages_path(root / "runtime" / "python")
        / "agentos"
        / "gateway"
        / "static"
        / "dist"
        / "index.html"
    )
    index.unlink()
    with pytest.raises(SystemExit, match="Control UI bundle is missing"):
        module.verify_desktop_runtime(root, run_import_probe=False)


def test_verify_rejects_a_non_executable_interpreter(module, tmp_path: Path) -> None:
    root = build_runtime_tree(module, tmp_path)
    (root / "runtime" / "python" / "bin" / "python3.12").chmod(0o644)
    with pytest.raises(SystemExit, match="not executable"):
        module.verify_desktop_runtime(root, run_import_probe=False)
