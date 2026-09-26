"""Generate SecondShift LinkedIn banner featuring the full-color logo.

Quality approach:
- Rendered at 2x (3168x792) then Lanczos-downscaled to 1584x396 (crisp AA).
- The wordmark is pasted at EXACTLY its native 1704x215 pixels on the 2x
  canvas (852 CSS px wide) — zero resampling on the logo itself.
- Ghost echo of the logo behind it for depth, blurred and faint.
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W2, H2 = 3168, 792  # 2x canvas
logo = Image.open("public/logo.png").convert("RGBA")  # 1704x215 native

img = Image.new("RGB", (W2, H2), "#000000")

# ambient glows (site palette), generous blur
glow = Image.new("RGB", (W2, H2), "#000000")
gd = ImageDraw.Draw(glow)
gd.ellipse([-500, -500, 1100, 520], fill="#0c2b47")
gd.ellipse([2200, 350, 3600, 1350], fill="#241a05")
glow = glow.filter(ImageFilter.GaussianBlur(260))
img = Image.blend(img, glow, 0.85)
d = ImageDraw.Draw(img)

# faint dot texture
for x in range(0, W2, 84):
    for y in range(0, H2, 84):
        d.ellipse([x, y, x + 4, y + 4], fill="#0d0d10")

# ghost echo: logo blown up, blurred, very faint — depth behind the real mark
ghost = logo.resize((2800, 353), Image.LANCZOS)
ghost_alpha = ghost.getchannel("A").point(lambda a: int(a * 0.13))
ghost.putalpha(ghost_alpha)
img.paste(ghost, ((W2 - 2800) // 2, 120), ghost)

# the real wordmark at native resolution — pixel-perfect
lw, lh = logo.size  # 1704 x 215
lx = (W2 - lw) // 2  # 732
ly = 240
# soft glow behind the mark: blurred copy of itself, slightly stronger alpha
halo = logo.resize((lw + 60, lh + 60), Image.LANCZOS).filter(ImageFilter.GaussianBlur(18))
halo_alpha = halo.getchannel("A").point(lambda a: int(a * 0.35))
halo.putalpha(halo_alpha)
halo_rgb = Image.new("RGBA", halo.size, "#2997ff")
halo_rgb.putalpha(halo_alpha)
img.paste(halo_rgb, (lx - 30, ly - 30), halo_rgb)
img.paste(logo, (lx, ly), logo)

# tagline centered under the wordmark
d = ImageDraw.Draw(img)
AR = "C:/Windows/Fonts/arialbd.ttf"
AR_R = "C:/Windows/Fonts/arial.ttf"
f_tag = ImageFont.truetype(AR_R, 38)
f_site = ImageFont.truetype(AR, 30)
tag = "AI employees for small businesses · phone, reviews, bookings — 24/7"
bb = d.textbbox((0, 0), tag, font=f_tag)
tw = bb[2] - bb[0]
d.text(((W2 - tw) // 2, 560), tag, font=f_tag, fill="#a1a1a6")
site = "secondshift.space"
bb2 = d.textbbox((0, 0), site, font=f_site)
d.text(((W2 - (bb2[2]-bb2[0])) // 2, 640), site, font=f_site, fill="#2997ff")

# supersample down to final size
final = img.resize((1584, 396), Image.LANCZOS)
final.save("public/linkedin-banner-logo.png", optimize=True)
print("saved public/linkedin-banner-logo.png", final.size)
