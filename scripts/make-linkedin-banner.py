"""Generate SecondShift LinkedIn banner (1584x396) — brand-matched to the site."""
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1584, 396
img = Image.new("RGB", (W, H), "#000000")
d = ImageDraw.Draw(img)

# soft blue glow top-left, warm accent bottom-right (site's --accent / --accent-warm)
glow = Image.new("RGB", (W, H), "#000000")
gd = ImageDraw.Draw(glow)
gd.ellipse([-300, -260, 640, 300], fill="#0c2b47")
gd.ellipse([1150, 180, 1900, 720], fill="#241a05")
glow = glow.filter(ImageFilter.GaussianBlur(140))
img = Image.blend(img, glow, 0.85)
d = ImageDraw.Draw(img)

# subtle grid of dots, very faint, right side (texture like the site's ambient style)
for x in range(0, W, 42):
    for y in range(0, H, 42):
        d.ellipse([x, y, x + 2, y + 2], fill="#0d0d10")

AR = "C:/Windows/Fonts/arialbd.ttf"
AR_R = "C:/Windows/Fonts/arial.ttf"
f_name = ImageFont.truetype(AR, 64)
f_sub = ImageFont.truetype(AR_R, 30)
f_small = ImageFont.truetype(AR, 22)

X = 262  # mobile-safe: LinkedIn's app crops ~225px off each edge of 1584px
# name
d.text((X, 108), "Rishi Raj Singh", font=f_name, fill="#f5f5f7")
# subtitle
d.text((X, 196), "I build AI employees for small businesses —", font=f_sub, fill="#a1a1a6")
d.text((X, 238), "they answer the phone, chase reviews and book jobs 24/7.", font=f_sub, fill="#a1a1a6")
# accent link
d.text((X, 312), "secondshift.space", font=f_small, fill="#2997ff")

# SecondShift signature: row of 6 colored squares top-right (echo of the colorful logo)
cols = ["#f59e0b", "#2997ff", "#34c759", "#bf5af2", "#ff375f", "#64d2ff"]
sq = 26
RIGHT = W - 262  # keep the squares inside the mobile-safe area too
for i, c in enumerate(cols):
    x0 = RIGHT - (len(cols) - i) * (sq + 10)
    d.rounded_rectangle([x0, 84, x0 + sq, 84 + sq], radius=6, fill=c)
d.text((RIGHT - 214, 130), "SECOND SHIFT", font=ImageFont.truetype(AR, 20), fill="#f5f5f7")

img.save("public/linkedin-banner.png", optimize=True)
print("saved public/linkedin-banner.png", img.size)
