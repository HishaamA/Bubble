"""Build new launcher PNGs from Bubble's four-ring vector geometry, not photos.

Run with Python + Pillow. Existing primary icons and the supplied reference image
are never read or modified. Android adaptive/vector icons remain source assets.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PALETTES = {"forest": ("#08382f", "#f5eed6"), "midnight": ("#07163d", "#fff0d3")}
# Same centers, radii and stroke ratios as the four-ring app mark (24-unit glyph).
RINGS = [(8, 8, 3.2), (16.5, 7, 2.2), (15, 15.5, 4.1), (6.5, 16.5, 1.7)]


def render(size, background, foreground):
    supersample = 4
    scale = size * supersample / 1024
    canvas = Image.new("RGB", (size * supersample, size * supersample), background)
    draw = ImageDraw.Draw(canvas)
    # Existing full-square iOS icon placement, with the same cream ring weight.
    for x, y, radius in RINGS:
        cx, cy = (67.6 + x * 37.2) * scale, (57.9 + y * 37.2) * scale
        outer, inner = (radius + .85) * 37.2 * scale, (radius - .85) * 37.2 * scale
        draw.ellipse((cx - outer, cy - outer, cx + outer, cy + outer), fill=foreground)
        draw.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill=background)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


for theme, (background, foreground) in PALETTES.items():
    catalog = ROOT / "ios/App/App/Assets.xcassets" / f"AppIcon{theme.title()}.appiconset"
    catalog.mkdir(parents=True, exist_ok=True)
    render(1024, background, foreground).save(catalog / "icon.png")
    for density, size in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
        destination = ROOT / f"android/app/src/main/res/mipmap-{density}/ic_launcher_{theme}.png"
        destination.parent.mkdir(parents=True, exist_ok=True)
        render(size, background, foreground).save(destination)
    print(f"Generated {theme}: 1 iOS icon, 5 legacy Android sizes")
