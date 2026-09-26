"""Generate SecondShift square company logo (512x512) for LinkedIn company page.

Brand mark: 3x2 grid of the logo's letter-tile colors on the site's black,
rendered at 2x and Lanczos-downscaled for crisp edges.
"""
from PIL import Image, ImageDraw

S2 = 1024  # 2x canvas
S = 512

img = Image.new("RGB", (S2, S2), "#000000")
d = ImageDraw.Draw(img)

# same palette as the wordmark tiles / banner signature
cols = ["#f59e0b", "#2997ff", "#34c759",
        "#bf5af2", "#ff375f", "#64d2ff"]

# 3x2 grid of rounded tiles, centered
tile = 200
gap = 34
grid_w = 3 * tile + 2 * gap
grid_h = 2 * tile + gap
x0 = (S2 - grid_w) // 2
y0 = (S2 - grid_h) // 2
for i, c in enumerate(cols):
    r, cidx = divmod(i, 3)
    tx = x0 + cidx * (tile + gap)
    ty = y0 + r * (tile + gap)
    d.rounded_rectangle([tx, ty, tx + tile, ty + tile], radius=44, fill=c)

final = img.resize((S, S), Image.LANCZOS)
final.save("public/company-logo.png", optimize=True)
print("saved public/company-logo.png", final.size)
