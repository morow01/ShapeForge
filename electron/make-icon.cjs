// Builds electron/icon.ico (and icon.png) from public/logo.svg. Run: node electron/make-icon.cjs
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const svg = fs.readFileSync(path.join(__dirname, '../public/logo.svg'));
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function render(size) {
  // The logo is a little taller than wide: fit it inside a transparent square.
  const inner = Math.round(size * 0.94);
  const logo = await sharp(svg, { density: 384 }).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toBuffer();
}

(async () => {
  const images = [];
  for (const size of SIZES) images.push({ size, data: await render(size) });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
  fs.writeFileSync(path.join(__dirname, 'icon.png'), images[images.length - 1].data);
  console.log('icon.ico written with sizes', SIZES.join(', '));
})();
