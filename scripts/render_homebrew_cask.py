#!/usr/bin/env python3
"""Render the AgentOS Homebrew cask from a release tag and its built DMGs.

The template lives at ``packaging/homebrew/agentos.rb`` and carries
``__UPPER_SNAKE__`` placeholders. This script fills them with the release tag,
the version Tauri stamped into the DMG filenames, and the SHA-256 of each
architecture's DMG, then writes the finished cask to ``Casks/agentos.rb``. This
repository is its own Homebrew tap, so that path is what ``brew`` reads; the
``homebrew`` job in ``.github/workflows/desktop-release.yml`` merges it onto
``main`` after every desktop release.

Everything it needs is on disk: no network call, no GitHub API, and no second
source for the version. The DMGs are the artifacts the release actually
published, so a checksum computed here matches what a user downloads.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TEMPLATE = REPO_ROOT / "packaging" / "homebrew" / "agentos.rb"
DEFAULT_OUTPUT = REPO_ROOT / "Casks" / "agentos.rb"

# Tauri's DMG bundler names its output `<productName>_<version>_<arch>.dmg`.
# The version charset is restricted to what a release can actually spell
# (CalVer plus semver's `-rc1` / `+post1` markers): the captured text lands
# verbatim in Casks/agentos.rb, a Ruby file every `brew install` executes, so
# `"`/`#{`/`$` must never travel from a filename into it.
DMG_NAME = re.compile(r"^AgentOS_(?P<version>[0-9A-Za-z.+-]+)_(?P<arch>aarch64|x64)\.dmg$")

# Same reasoning for the tag, which is substituted into the cask's `url`.
TAG_FORMAT = re.compile(r"^v[0-9A-Za-z.-]+$")

# The cask's `arch` stanza maps Homebrew's two macOS arches onto these names,
# so the same two keys have to arrive from the filenames.
REQUIRED_ARCHES = ("aarch64", "x64")

PLACEHOLDER = re.compile(r"__[A-Z0-9_]+__")

CHUNK_SIZE = 1024 * 1024


class RenderError(RuntimeError):
    """A release input is missing or inconsistent; the cask is not written."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def collect_dmgs(dmg_dir: Path) -> dict[str, Path]:
    """Map arch -> DMG path for the macOS installers found in ``dmg_dir``.

    Non-macOS assets share the directory when the release workflow merges every
    platform's artifacts, so anything that is not a recognised DMG is ignored
    rather than treated as an error.
    """
    found: dict[str, Path] = {}
    for path in sorted(dmg_dir.glob("*.dmg")):
        match = DMG_NAME.match(path.name)
        if match is None:
            continue
        arch = match.group("arch")
        if arch in found:
            raise RenderError(f"two DMGs claim the {arch} slot: {found[arch].name} and {path.name}")
        found[arch] = path

    missing = [arch for arch in REQUIRED_ARCHES if arch not in found]
    if missing:
        listing = ", ".join(p.name for p in sorted(dmg_dir.glob("*.dmg"))) or "(none)"
        raise RenderError(
            f"no DMG for {', '.join(missing)} in {dmg_dir}; found: {listing}. "
            "A cask that ships one arch would send the other arch's users to a 404."
        )
    return found


def dmg_version(dmg_dir_contents: dict[str, Path]) -> str:
    """Return the single version both DMGs agree on."""
    versions = {}
    for arch, path in dmg_dir_contents.items():
        match = DMG_NAME.match(path.name)
        assert match is not None  # collect_dmgs only stores matching names
        versions[arch] = match.group("version")

    distinct = set(versions.values())
    if len(distinct) != 1:
        detail = ", ".join(f"{arch}={version}" for arch, version in sorted(versions.items()))
        raise RenderError(
            f"DMGs disagree on the version ({detail}); one of them is from another build"
        )
    return distinct.pop()


def pep440_from_semver(version: str) -> str:
    """Spell a desktop (semver) version the way ``pyproject.toml`` would.

    AGENTS.md fixes the mapping the release cut uses in the other direction: a
    plain CalVer copies over unchanged, a pre-release gains a hyphen
    (``2026.8.24rc1`` -> ``2026.8.24-rc1``), and a post-release becomes build
    metadata (``2026.8.24.post1`` -> ``2026.8.24+post1``). Reversing it lets the
    tag cross-check the DMGs instead of trusting them.
    """
    return version.replace("+", ".").replace("-", "")


def render(
    template: str,
    *,
    tag: str,
    version: str,
    sha256_arm: str,
    sha256_intel: str,
) -> str:
    substitutions = {
        "__TAG__": tag,
        "__VERSION__": version,
        "__SHA256_ARM__": sha256_arm,
        "__SHA256_INTEL__": sha256_intel,
    }
    rendered = template
    for placeholder, value in substitutions.items():
        rendered = rendered.replace(placeholder, value)

    # A renamed placeholder in the template would otherwise ship a cask that
    # downloads `.../AgentOS___VERSION___aarch64.dmg`.
    leftover = sorted(set(PLACEHOLDER.findall(rendered)))
    if leftover:
        raise RenderError(f"template has placeholders this script does not fill: {leftover}")
    return rendered


def build_cask(*, tag: str, dmg_dir: Path, template_path: Path) -> str:
    if TAG_FORMAT.fullmatch(tag) is None:
        raise RenderError(
            f"release tag must be 'v' plus [0-9A-Za-z.-]; got '{tag}'. The tag "
            "is substituted into executable Ruby, so no other characters travel."
        )
    if not template_path.is_file():
        raise RenderError(f"cask template not found: {template_path}")
    if not dmg_dir.is_dir():
        raise RenderError(f"DMG directory not found: {dmg_dir}")

    dmgs = collect_dmgs(dmg_dir)
    version = dmg_version(dmgs)

    expected = pep440_from_semver(version)
    if expected != tag[1:]:
        raise RenderError(
            f"tag {tag} and DMG version {version} are different releases "
            f"(the DMGs spell {expected}); the downloaded artifacts are stale"
        )

    return render(
        template_path.read_text(encoding="utf-8"),
        tag=tag,
        version=version,
        sha256_arm=sha256_file(dmgs["aarch64"]),
        sha256_intel=sha256_file(dmgs["x64"]),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="release tag, e.g. v2026.8.24")
    parser.add_argument(
        "--dmg-dir",
        type=Path,
        required=True,
        help="directory holding the built AgentOS_<version>_<arch>.dmg files",
    )
    parser.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        cask = build_cask(tag=args.tag, dmg_dir=args.dmg_dir, template_path=args.template)
    except RenderError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(cask, encoding="utf-8")
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
