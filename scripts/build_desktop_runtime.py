#!/usr/bin/env python3
"""Materialize the desktop app's bundled Python runtime resource tree.

The Tauri shell in ``desktop/`` ships AgentOS itself as a bundled resource: a
relocatable python-build-standalone interpreter with the AgentOS wheel and all
its dependencies already unpacked into ``site-packages``. Nothing is installed
on the user's machine at first launch — the shell spawns

    <runtime>/<python_exe> -m agentos.cli.main gateway run --bind 127.0.0.1 --port <n>

and waits for ``/health``.

The heavy lifting (runtime download, safe extraction, pruning, offline wheel
unpacking) already exists for the Windows portable zip, so this script imports
``build_wheelhouse_zip`` rather than reimplementing it. What is genuinely new
here is cross-platform layout resolution: the Windows ``install_only`` tree
spells its interpreter ``python.exe`` next to ``Lib/site-packages``, while
macOS/Linux use ``bin/python3`` next to ``lib/python3.12/site-packages``. The
resulting ``runtime.json`` manifest records the resolved spellings so the Rust
side never has to guess.

Usage:

    python scripts/build_desktop_runtime.py build
    python scripts/build_desktop_runtime.py verify
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import types
from dataclasses import dataclass
from pathlib import Path

MANIFEST_NAME = "runtime.json"
MANIFEST_SCHEMA_VERSION = 1
DEFAULT_PROFILE = "recommended"

# The CLI is launched as a module rather than through a console script: the
# bundled wheels are unpacked without their ``.data/scripts`` entries, so no
# ``bin/agentos`` shim exists. ``agentos.cli.main`` has the ``__main__`` guard
# that makes this equivalent.
CLI_MODULE = "agentos.cli.main"


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def load_wheelhouse_builder() -> types.ModuleType:
    """Import ``build_wheelhouse_zip`` from this script's own directory.

    Loaded by path rather than by package name so the script keeps working
    when ``scripts/`` is not on ``sys.path`` — which is how CI and the test
    suite both invoke it.
    """

    script_path = Path(__file__).resolve().parent / "build_wheelhouse_zip.py"
    spec = importlib.util.spec_from_file_location("build_wheelhouse_zip", script_path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"Could not load the wheelhouse builder: {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@dataclass(frozen=True)
class RuntimeLayout:
    """Where the interpreter and its site-packages live inside a runtime tree.

    Paths are relative to the runtime root (the directory holding the extracted
    python-build-standalone tree) and are always spelled with forward slashes
    so the manifest stays byte-identical across build hosts.
    """

    python_exe: str
    site_packages: str

    def python_exe_path(self, runtime_root: Path) -> Path:
        return runtime_root / self.python_exe

    def site_packages_path(self, runtime_root: Path) -> Path:
        return runtime_root / self.site_packages


def runtime_layout(platform_tag: str, python_version: str) -> RuntimeLayout:
    """Resolve the interpreter/site-packages spelling for a target platform.

    ``python_version`` is the full ``3.12.13`` triple; only major.minor reaches
    the path, which is why it is truncated here rather than at every call site.
    """

    parts = python_version.split(".")
    if len(parts) < 2:
        raise SystemExit(f"Unusable Python version for the runtime layout: {python_version!r}")
    major_minor = f"{parts[0]}.{parts[1]}"

    if platform_tag.startswith("windows-"):
        return RuntimeLayout(python_exe="python.exe", site_packages="Lib/site-packages")
    return RuntimeLayout(
        python_exe=f"bin/python{major_minor}",
        site_packages=f"lib/python{major_minor}/site-packages",
    )


def gateway_argv(layout: RuntimeLayout, *, host: str, port: int) -> list[str]:
    """The exact argv the desktop shell uses to start a gateway.

    Recorded in the manifest so the Rust supervisor and this builder can never
    drift apart on flag spelling.
    """

    return [
        layout.python_exe,
        "-m",
        CLI_MODULE,
        "gateway",
        "run",
        "--bind",
        host,
        "--port",
        str(port),
    ]


def build_manifest(
    *,
    agentos_version: str,
    platform_tag: str,
    python_version: str,
    runtime_release: str,
    profile: str,
    layout: RuntimeLayout,
) -> dict[str, object]:
    """Build the reproducible ``runtime.json`` payload.

    Deliberately free of timestamps, absolute paths, and hostnames: two builds
    of the same inputs must produce byte-identical manifests, and the file
    ships to users inside the app bundle.
    """

    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "agentos_version": agentos_version,
        "platform_tag": platform_tag,
        "python_version": python_version,
        "python_runtime_release": runtime_release,
        "profile": profile,
        "cli_module": CLI_MODULE,
        "python_exe": layout.python_exe,
        "site_packages": layout.site_packages,
    }


def read_manifest(resources_root: Path) -> dict[str, object]:
    manifest_path = resources_root / MANIFEST_NAME
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(
            f"Desktop runtime manifest is missing: {manifest_path}. "
            "Run: python scripts/build_desktop_runtime.py build"
        ) from exc
    except (OSError, ValueError) as exc:
        raise SystemExit(f"Desktop runtime manifest is unreadable: {manifest_path}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"Desktop runtime manifest is not an object: {manifest_path}")
    return payload


def write_manifest(resources_root: Path, manifest: dict[str, object]) -> Path:
    resources_root.mkdir(parents=True, exist_ok=True)
    manifest_path = resources_root / MANIFEST_NAME
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def verify_desktop_runtime(resources_root: Path, *, run_import_probe: bool = True) -> None:
    """Fail loudly on a runtime tree the shell could not actually launch.

    ``run_import_probe`` executes the bundled interpreter, so it is only
    meaningful when the build host matches the target platform. Cross-platform
    CI jobs still get the structural checks.
    """

    manifest = read_manifest(resources_root)
    runtime_root = resources_root / "runtime" / "python"
    if not runtime_root.is_dir():
        raise SystemExit(f"Bundled Python runtime is missing: {runtime_root}")

    python_exe = runtime_root / str(manifest.get("python_exe", ""))
    if not python_exe.is_file():
        raise SystemExit(f"Bundled interpreter is missing: {python_exe}")

    site_packages = runtime_root / str(manifest.get("site_packages", ""))
    if not site_packages.is_dir():
        raise SystemExit(f"Bundled site-packages is missing: {site_packages}")

    agentos_pkg = site_packages / "agentos"
    if not (agentos_pkg / "cli" / "main.py").is_file():
        raise SystemExit(f"AgentOS is not installed into the bundled runtime: {agentos_pkg}")

    # The Control UI is what the desktop window actually loads. A runtime that
    # ships without it starts a gateway that answers /health and then serves an
    # actionable 503 for every navigation, which reads as "the app is broken".
    control_ui_index = agentos_pkg / "gateway" / "static" / "dist" / "index.html"
    if not control_ui_index.is_file():
        raise SystemExit(
            f"Control UI bundle is missing from the desktop runtime: {control_ui_index}. "
            "Run: python scripts/build_control_ui.py build"
        )

    if os.name != "nt" and not os.access(python_exe, os.X_OK):
        raise SystemExit(f"Bundled interpreter is not executable: {python_exe}")

    if not run_import_probe:
        return

    probe = subprocess.run(
        [str(python_exe), "-c", "import agentos; print(agentos.__version__)"],
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise SystemExit(
            "Bundled runtime cannot import agentos:\n"
            f"{probe.stdout.strip()}\n{probe.stderr.strip()}"
        )
    probed = probe.stdout.strip()
    expected = str(manifest.get("agentos_version", ""))
    if probed != expected:
        raise SystemExit(
            f"Bundled runtime reports agentos {probed!r}, manifest says {expected!r}."
        )


def build_desktop_runtime(
    *,
    repo_root: Path,
    resources_root: Path,
    work_dir: Path,
    platform_tag: str,
    profile: str,
    python_version: str,
    runtime_release: str,
    skip_control_ui: bool,
) -> Path:
    builder = load_wheelhouse_builder()

    agentos_version = builder.read_project_version(repo_root)
    layout = runtime_layout(platform_tag, python_version)
    env = builder.build_subprocess_env(work_dir)

    if not skip_control_ui:
        builder.build_control_ui_dist(repo_root, env)

    wheel_dir = work_dir / "wheels"
    package_dir = work_dir / "packages"
    for stale in (wheel_dir, package_dir):
        if stale.exists():
            shutil.rmtree(stale)
    wheel_dir.mkdir(parents=True)
    package_dir.mkdir(parents=True)

    wheel_path = builder.build_wheel(repo_root, wheel_dir, env)
    missing_ui = builder.missing_control_ui_assets_in_wheel(wheel_path)
    if missing_ui:
        raise SystemExit(
            "Built wheel is missing Control UI assets: "
            + ", ".join(missing_ui)
            + "\nRun: python scripts/build_control_ui.py build"
        )

    builder.download_wheelhouse(
        package_dir,
        wheel_path,
        profile,
        env,
        target_platform_tag=platform_tag,
        python_major=sys.version_info.major,
        python_minor=sys.version_info.minor,
    )

    runtime_root = resources_root / "runtime" / "python"
    archive_path, _asset_name = builder.download_python_runtime_archive(
        download_dir=work_dir / "runtime-archives",
        python_version=python_version,
        runtime_release=runtime_release,
        platform_tag=platform_tag,
    )
    builder.extract_python_runtime_archive(archive_path, runtime_root)
    builder.prune_portable_runtime(runtime_root)

    site_packages = layout.site_packages_path(runtime_root)
    if not site_packages.is_dir():
        raise SystemExit(
            f"Extracted runtime has no {layout.site_packages} directory: {runtime_root}"
        )
    builder.install_wheels_into_site_packages(package_dir, site_packages)
    builder.prune_portable_runtime(runtime_root)

    manifest = build_manifest(
        agentos_version=agentos_version,
        platform_tag=platform_tag,
        python_version=python_version,
        runtime_release=runtime_release,
        profile=profile,
        layout=layout,
    )
    write_manifest(resources_root, manifest)
    return resources_root


def _default_resources_root(repo_root: Path) -> Path:
    return repo_root / "desktop" / "src-tauri" / "resources"


def main(argv: list[str] | None = None) -> int:
    builder_defaults = load_wheelhouse_builder()
    repo_root = repo_root_from_script()

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("build", "verify"))
    parser.add_argument(
        "--platform-tag",
        default=builder_defaults.platform_tag(),
        help="Target platform tag, e.g. macos-arm64 (default: this host)",
    )
    parser.add_argument("--profile", default=DEFAULT_PROFILE, help="Extras profile to bundle")
    parser.add_argument(
        "--python-runtime-release",
        default=builder_defaults.DEFAULT_RUNTIME_RELEASE,
        help="python-build-standalone release tag",
    )
    parser.add_argument(
        "--python-runtime-version",
        default=builder_defaults.DEFAULT_RUNTIME_PYTHON_VERSION,
        help="Full CPython version from python-build-standalone",
    )
    parser.add_argument(
        "--resources-root",
        type=Path,
        default=None,
        help="Where to write the runtime tree (default: desktop/src-tauri/resources)",
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=None,
        help="Scratch directory for wheels and downloads (default: build/desktop-runtime)",
    )
    parser.add_argument(
        "--skip-control-ui",
        action="store_true",
        help="Trust the existing Control UI bundle instead of rebuilding it",
    )
    parser.add_argument(
        "--skip-import-probe",
        action="store_true",
        help="Skip executing the bundled interpreter (required for cross-platform builds)",
    )
    args = parser.parse_args(argv)

    resources_root = args.resources_root or _default_resources_root(repo_root)
    work_dir = args.work_dir or (repo_root / "build" / "desktop-runtime")

    if args.command == "verify":
        verify_desktop_runtime(resources_root, run_import_probe=not args.skip_import_probe)
        print(f"Desktop runtime OK: {resources_root}")
        return 0

    work_dir.mkdir(parents=True, exist_ok=True)
    build_desktop_runtime(
        repo_root=repo_root,
        resources_root=resources_root,
        work_dir=work_dir,
        platform_tag=args.platform_tag,
        profile=args.profile,
        python_version=args.python_runtime_version,
        runtime_release=args.python_runtime_release,
        skip_control_ui=args.skip_control_ui,
    )
    verify_desktop_runtime(resources_root, run_import_probe=not args.skip_import_probe)
    print(f"Desktop runtime built: {resources_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
