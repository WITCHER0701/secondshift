/**
 * One-off: build brand assets from the SecondShift logo image.
 *  - public/logo.png              transparent wordmark (nav + footer + og)
 *  - public/favicon.png           square "S" tile icon
 *  - public/apple-touch-icon.png  180px
 *
 * Pipeline: crop to the wordmark bbox → key out the green backdrop →
 * flood-clear weak pixels (frame remnants, blends) reachable from the
 * edges → solidify white letters → export.
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SRC = 'D:/Downloads/Gemini_Generated_Image_ch7yo3ch7yo3ch7y.png';
const OUT = path.join(__dirname, '..', 'public');

(async () => {
  const meta = await sharp(SRC).metadata();
  console.log('source:', meta.width, 'x', meta.height);

  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  const isGreenish = (i) => { const r = data[i], g = data[i+1], b = data[i+2]; return g > r + 15 && g > b + 15; };
  const isWhiteish = (i) => { const r = data[i], g = data[i+1], b = data[i+2]; return r > 225 && g > 225 && b > 225; };

  // bbox of colored tiles (exclude green + white)
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (isGreenish(i) || isWhiteish(i)) continue;
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const pad = 6;
  const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad);
  const width = Math.min(W, maxX + pad) - left, height = Math.min(H, maxY + pad) - top;
  console.log('bbox:', { left, top, width, height });

  const { data: cd, info: ci } = await sharp(SRC)
    .extract({ left, top, width, height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const CW = ci.width, CH = ci.height;
  const alpha = new Uint8Array(CW * CH).fill(255);
  const idx = (x, y) => (y * CW + x) * 4;

  // pass 1: green → transparent
  for (let p = 0; p < CW * CH; p++) {
    const i = p * 4;
    if (cd[i+1] > cd[i] + 15 && cd[i+1] > cd[i+2] + 15) alpha[p] = 0;
  }

  // pass 2: flood from borders — clear weak pixels (white frame remnants,
  // green-white blends) connected to the edge so letters (inside tiles) survive
  const isWeak = (x, y) => {
    const i = idx(x, y);
    if (alpha[y * CW + x] === 0) return true;
    const r = cd[i], g = cd[i+1], b = cd[i+2];
    const whiteish = r > 200 && g > 200 && b > 200;
    const pale = r > 170 && g > 170 && b > 170 && Math.abs(r - g) < 40 && Math.abs(g - b) < 40;
    return whiteish || pale;
  };
  const visited = new Uint8Array(CW * CH);
  const stack = [];
  for (let x = 0; x < CW; x++) { stack.push([x, 0], [x, CH - 1]); }
  for (let y = 0; y < CH; y++) { stack.push([0, y], [CW - 1, y]); }
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= CW || y >= CH) continue;
    const p = y * CW + x;
    if (visited[p]) continue;
    visited[p] = 1;
    if (!isWeak(x, y)) continue;
    alpha[p] = 0;
    stack.push([x+1, y], [x-1, y], [x, y+1], [x, y-1]);
  }

  // pass 3: solidify letters — near-white inside tiles → pure white opaque
  for (let p = 0; p < CW * CH; p++) {
    if (alpha[p] === 0) continue;
    const i = p * 4;
    const r = cd[i], g = cd[i+1], b = cd[i+2];
    if (r > 215 && g > 215 && b > 215) { cd[i] = cd[i+1] = cd[i+2] = 255; cd[i+3] = 255; }
    else cd[i+3] = alpha[p];
  }

  const out = sharp(cd, { raw: { width: CW, height: CH, channels: 4 } });
  await out.clone().png().toFile(path.join(OUT, 'logo.png'));
  console.log('logo.png', CW, 'x', CH);

  // favicon: square "S" tile from the left of the wordmark
  const sq = CH;
  const favBuf = await sharp(cd, { raw: { width: CW, height: CH, channels: 4 } })
    .extract({ left: 0, top: 0, width: Math.min(sq, CW), height: sq })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  fs.writeFileSync(path.join(OUT, 'favicon.png'), favBuf);
  fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), await sharp(favBuf).resize(180, 180).png().toBuffer());
  console.log('favicon + apple-touch-icon done');
})().catch((e) => { console.error(e); process.exit(1); });
