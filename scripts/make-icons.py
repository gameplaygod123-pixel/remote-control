"""Render the app icon: glossy-black squircle plate on Apple's icon grid.

Two things the old assets got wrong, both visible in the Dock next to real apps:
  * `qlmanage -t` rasterized onto an opaque white page -> four solid white
    corners outside the plate.
  * the plate filled the whole canvas -> the icon read noticeably BIGGER than
    every neighbour. macOS's grid puts a "large rounded rect" app at 855/1024
    (83.5%), nudged up a few px for the Dock's shadow: measured identical on
    Mail, Safari, Notes and (within 1px) Chrome.

Plate styling follows MuMuPlayer's icon, which the owner picked as the
reference: a black plate with a thin lighter rim catching the "light" at the
very edge (sampled: rgb(23,23,23) at the edge, fading to black ~6px in at
1024), plus a whisper of a cooler glow low in the plate.

Windows/tray art stays full-bleed: only macOS has the grid convention, and a
16px tray icon can't spare 17% of its pixels to margin.
"""
from PIL import Image, ImageDraw, ImageFilter

CANVAS = 1024
# macOS grid, measured off Mail.app/Safari.app/Notes.app at 1024:
GRID_W = 855
GRID_X = 85
GRID_Y = 92

SS = 4  # supersample

# Window marks, in a 120-unit box spanning the plate (matches icon.svg's geometry)
BACK = dict(xy=(24, 34, 70, 68), r=4, stroke=(92, 74, 61), w=3.5)
FRONT = dict(xy=(50, 52, 96, 86), r=4, fill=(28, 22, 17), stroke=(232, 130, 90), w=3.5)
DOT = dict(c=(24, 34), r=3, fill=(139, 195, 74))

# Sampled off MuMuPlayer's plate (the owner picked its background): a 45-degree
# linear gradient, pure black at the top-left corner easing to a dark navy at the
# bottom-right, and a hairline rim a touch lighter than the fill catching the
# light all the way round.
RIM_TOP = (92, 94, 104)
RIM_BOTTOM = (20, 20, 26)
RIM_W = 0.010  # rim thickness, fraction of plate width
GRAD_TL = (0, 0, 0)
GRAD_BR = (0, 14, 46)


RADIUS = 0.225  # of plate width -- measured off MuMuPlayer's plate; a superellipse
# ("squircle") bows the straight edges too and reads as a blob at this size.


def squircle(d: ImageDraw.ImageDraw, box, fill):
    d.rounded_rectangle(box, radius=(box[2] - box[0]) * RADIUS, fill=fill)


def render(px: int, grid: bool) -> Image.Image:
    S = px * SS
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    if grid:
        k = S / CANVAS
        pw = GRID_W * k
        px0, py0 = GRID_X * k, GRID_Y * k
    else:
        pw = S
        px0 = py0 = 0
    box = (px0, py0, px0 + pw, py0 + pw)

    # Rim: the plate is drawn in the rim colour and the gradient plate is inset over
    # it, leaving a hairline of rim at the edge. The rim is a vertical gradient --
    # bright at the top, dim at the bottom -- which is what reads as a lit, convex
    # slab rather than a flat sticker (MuMu's own rim is nearly uniform ~12-23 and
    # too subtle to give the dimension the owner asked for).
    rim = Image.new("RGBA", (S, S))
    rp = rim.load()
    for y in range(S):
        t = (y - py0) / pw
        t = 0.0 if t < 0 else (1.0 if t > 1 else t)
        c = tuple(round(a + (b - a) * t) for a, b in zip(RIM_TOP, RIM_BOTTOM))
        for x in range(S):
            rp[x, y] = c + (255,)
    rim_mask = Image.new("L", (S, S), 0)
    squircle(ImageDraw.Draw(rim_mask), box, 255)
    im.paste(rim, (0, 0), rim_mask)

    inset = pw * RIM_W
    inner = (box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset)

    grad = Image.new("RGBA", (S, S))
    gp = grad.load()
    for y in range(S):
        for x in range(S):
            t = ((x - px0) / pw + (y - py0) / pw) / 2  # 0 at top-left of plate, 1 at bottom-right
            t = 0.0 if t < 0 else (1.0 if t > 1 else t)
            gp[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(GRAD_TL, GRAD_BR)) + (255,)
    mask = Image.new("L", (S, S), 0)
    squircle(ImageDraw.Draw(mask), inner, 255)
    im.paste(grad, (0, 0), mask)

    # window marks, scaled into the plate
    u = pw / 120.0

    def B(xy):
        return [px0 + xy[0] * u, py0 + xy[1] * u, px0 + xy[2] * u, py0 + xy[3] * u]

    d = ImageDraw.Draw(im)
    d.rounded_rectangle(B(BACK["xy"]), radius=BACK["r"] * u, outline=BACK["stroke"], width=round(BACK["w"] * u))
    d.rounded_rectangle(
        B(FRONT["xy"]), radius=FRONT["r"] * u, fill=FRONT["fill"], outline=FRONT["stroke"], width=round(FRONT["w"] * u)
    )
    cx, cy = DOT["c"]
    r = DOT["r"]
    d.ellipse(B((cx - r, cy - r, cx + r, cy + r)), fill=DOT["fill"])

    return im.resize((px, px), Image.LANCZOS)


if __name__ == "__main__":
    import os
    import sys

    out = sys.argv[1]
    os.makedirs(f"{out}/icon.iconset", exist_ok=True)

    render(512, grid=True).save(f"{out}/icon.png")

    # .icns: iconutil wants an .iconset dir with Apple's exact filenames.
    for size in (16, 32, 128, 256, 512):
        render(size, grid=True).save(f"{out}/icon.iconset/icon_{size}x{size}.png")
        render(size * 2, grid=True).save(f"{out}/icon.iconset/icon_{size}x{size}@2x.png")

    # .ico: PIL packs a real multi-size ICO (the original was hand-packed
    # single-size because no ico writer was available at the time).
    render(256, grid=True).save(
        f"{out}/icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("rendered to", out)
