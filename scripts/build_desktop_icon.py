#!/usr/bin/env python3
"""Render the AgentOS desktop app and tray icons.

``cargo tauri icon`` needs a single 1024x1024 source and fans it out into the
.icns / .ico / PNG set that ships in ``desktop/src-tauri/icons/``. That fan-out
is committed, so this script only runs when the mark itself changes:

    python scripts/build_desktop_icon.py app
    python scripts/build_desktop_icon.py tray
    python scripts/build_desktop_icon.py tray-color
    cargo tauri icon desktop/src-tauri/icons/icon-source.png -o desktop/src-tauri/icons

The repository's stacked logo is not usable as an app icon directly: it is
500x500, mostly whitespace, and carries the wordmark, which is illegible at the
16px sizes a dock or tray uses. So the molecule mark is redrawn here at icon
proportions on the brand's near-black ground.

The tray variants drop the plate and render the bare mark. ``tray`` is a macOS
template image — pure black plus an alpha channel, which the system recolors
for light/dark menu bars — while ``tray-color`` is the lime mark used on
Windows and Linux, where no such recoloring happens and a black icon would
disappear into a dark taskbar.

Colors are the Control UI's own tokens (``frontend/src/styles/globals.css``):
lime #CCFF00 as the single signal color on the #0E0E13 lifted surface.

No third-party dependency: shapes are rasterized from signed distance fields
and the PNG is emitted with ``zlib`` + ``struct``, so the script runs on a bare
interpreter in CI as readily as locally.
"""

from __future__ import annotations

import argparse
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

BACKGROUND = (0x0E, 0x0E, 0x13)
SIGNAL = (0xCC, 0xFF, 0x00)
TEMPLATE_BLACK = (0x00, 0x00, 0x00)

# Squircle exponent. 4.0 lands close to the macOS continuous-corner shape;
# lower values round harder, higher values approach a square.
SQUIRCLE_EXPONENT = 4.0

# Geometry as a fraction of the canvas, so every variant scales from one
# source of truth. Proportions are lifted from assets/agentos-stacked-logo.png.
SQUIRCLE_INSET = 24.0 / 1024.0
HUB = (512.0 / 1024.0, 520.0 / 1024.0, 124.0 / 1024.0)
NODES = (
    (512.0 / 1024.0, 244.0 / 1024.0, 62.0 / 1024.0),
    (262.0 / 1024.0, 714.0 / 1024.0, 56.0 / 1024.0),
    (762.0 / 1024.0, 714.0 / 1024.0, 56.0 / 1024.0),
)
BOND_HALF_WIDTH = 15.0 / 1024.0

# The tray mark has no plate to sit inside, so it is scaled up about its own
# centre to use the full canvas instead of the plate's safe area.
TRAY_MARK_SCALE = 1.28

# Coverage ramp, in pixels, used to antialias every edge.
EDGE = 1.0


@dataclass(frozen=True)
class Variant:
    """One renderable icon: canvas size, colors, and whether to draw a plate."""

    name: str
    size: int
    mark: tuple[int, int, int]
    plate: tuple[int, int, int] | None
    mark_scale: float
    filename: str


VARIANTS: dict[str, Variant] = {
    "app": Variant(
        name="app",
        size=1024,
        mark=SIGNAL,
        plate=BACKGROUND,
        mark_scale=1.0,
        filename="icon-source.png",
    ),
    "tray": Variant(
        name="tray",
        size=64,
        mark=TEMPLATE_BLACK,
        plate=None,
        mark_scale=TRAY_MARK_SCALE,
        filename="tray.png",
    ),
    "tray-color": Variant(
        name="tray-color",
        size=64,
        mark=SIGNAL,
        plate=None,
        mark_scale=TRAY_MARK_SCALE,
        filename="tray-color.png",
    ),
}


def _coverage(distance: float) -> float:
    """Map a signed distance to coverage in [0, 1] with a linear ramp.

    Negative distance is inside the shape. The ramp is deliberately linear
    rather than cubic: at these radii the difference is invisible, and a linear
    ramp keeps the mark's edges from looking soft.
    """

    if distance <= -EDGE:
        return 1.0
    if distance >= EDGE:
        return 0.0
    return (EDGE - distance) / (2.0 * EDGE)


def _circle_distance(x: float, y: float, cx: float, cy: float, radius: float) -> float:
    return ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 - radius


def _segment_distance(
    x: float,
    y: float,
    ax: float,
    ay: float,
    bx: float,
    by: float,
    half_width: float,
) -> float:
    """Distance to a capsule: the segment AB dilated by ``half_width``."""

    px, py = x - ax, y - ay
    dx, dy = bx - ax, by - ay
    length_squared = dx * dx + dy * dy
    if length_squared == 0.0:
        projection = 0.0
    else:
        projection = (px * dx + py * dy) / length_squared
        projection = min(1.0, max(0.0, projection))
    qx, qy = px - dx * projection, py - dy * projection
    return (qx * qx + qy * qy) ** 0.5 - half_width


def _squircle_distance(x: float, y: float, size: int) -> float:
    """Approximate signed distance to a centered superellipse.

    The exact distance to a superellipse has no closed form, so the implicit
    value is normalized by its gradient — accurate to well under a pixel at
    the boundary, which is the only place coverage is not saturated.
    """

    half = size / 2.0
    radius = half - SQUIRCLE_INSET * size
    nx = (x - half) / radius
    ny = (y - half) / radius
    ax, ay = abs(nx), abs(ny)
    if ax == 0.0 and ay == 0.0:
        return -radius

    n = SQUIRCLE_EXPONENT
    value = ax**n + ay**n - 1.0
    gradient = n * (ax ** (n - 1) + ay ** (n - 1))
    if gradient == 0.0:
        return value * radius
    return value / gradient * radius


def _scaled_geometry(variant: Variant) -> tuple[tuple[float, float, float], ...]:
    """Return hub-first geometry in pixels for this variant's canvas."""

    size = variant.size
    scale = variant.mark_scale
    centre = size / 2.0

    def place(fraction: tuple[float, float, float]) -> tuple[float, float, float]:
        fx, fy, fr = fraction
        x = centre + (fx * size - centre) * scale
        y = centre + (fy * size - centre) * scale
        return x, y, fr * size * scale

    return (place(HUB), *(place(node) for node in NODES))


def _mark_distance(
    x: float,
    y: float,
    geometry: tuple[tuple[float, float, float], ...],
    bond_half_width: float,
) -> float:
    hub_x, hub_y, hub_r = geometry[0]
    best = _circle_distance(x, y, hub_x, hub_y, hub_r)
    for node_x, node_y, node_r in geometry[1:]:
        best = min(best, _circle_distance(x, y, node_x, node_y, node_r))
        best = min(
            best,
            _segment_distance(x, y, hub_x, hub_y, node_x, node_y, bond_half_width),
        )
    return best


def render_icon(variant: Variant) -> bytearray:
    """Rasterize one variant into a straight-alpha RGBA buffer."""

    size = variant.size
    pixels = bytearray(size * size * 4)
    geometry = _scaled_geometry(variant)
    bond_half_width = BOND_HALF_WIDTH * size * variant.mark_scale
    mark_r, mark_g, mark_b = variant.mark

    for row in range(size):
        y = row + 0.5
        offset = row * size * 4
        for column in range(size):
            x = column + 0.5
            mark = _coverage(_mark_distance(x, y, geometry, bond_half_width))
            if variant.plate is None:
                # Plateless variants carry the mark in the alpha channel only,
                # which is what a macOS template image is defined to be.
                if mark > 0.0:
                    pixels[offset] = mark_r
                    pixels[offset + 1] = mark_g
                    pixels[offset + 2] = mark_b
                    pixels[offset + 3] = int(mark * 255.0 + 0.5)
                offset += 4
                continue

            plate = _coverage(_squircle_distance(x, y, size))
            if plate <= 0.0:
                offset += 4
                continue
            bg_r, bg_g, bg_b = variant.plate
            pixels[offset] = int(bg_r + (mark_r - bg_r) * mark + 0.5)
            pixels[offset + 1] = int(bg_g + (mark_g - bg_g) * mark + 0.5)
            pixels[offset + 2] = int(bg_b + (mark_b - bg_b) * mark + 0.5)
            pixels[offset + 3] = int(plate * 255.0 + 0.5)
            offset += 4
    return pixels


def encode_png(pixels: bytearray, size: int) -> bytes:
    """Wrap an RGBA buffer in a minimal, deterministic PNG container."""

    raw = bytearray()
    stride = size * 4
    for row in range(size):
        raw.append(0)  # filter type 0 (None) — keeps the encoder trivial
        raw.extend(pixels[row * stride : (row + 1) * stride])

    def chunk(tag: bytes, payload: bytes) -> bytes:
        body = tag + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"".join(
        (
            b"\x89PNG\r\n\x1a\n",
            chunk(b"IHDR", header),
            chunk(b"IDAT", zlib.compress(bytes(raw), 9)),
            chunk(b"IEND", b""),
        )
    )


def main(argv: list[str] | None = None) -> int:
    icons_dir = Path(__file__).resolve().parents[1] / "desktop" / "src-tauri" / "icons"
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("variant", choices=(*VARIANTS, "all"))
    parser.add_argument("--icons-dir", type=Path, default=icons_dir)
    args = parser.parse_args(argv)

    selected = list(VARIANTS.values()) if args.variant == "all" else [VARIANTS[args.variant]]
    args.icons_dir.mkdir(parents=True, exist_ok=True)
    for variant in selected:
        output = args.icons_dir / variant.filename
        output.write_bytes(encode_png(render_icon(variant), variant.size))
        print(f"Wrote {output} ({variant.size}x{variant.size})")

    if any(variant.name == "app" for variant in selected):
        source = args.icons_dir / VARIANTS["app"].filename
        print(f"Next: cargo tauri icon {source} -o {args.icons_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
