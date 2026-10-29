/**
 * Draws the toolbar icons (a dark tile with two text lines and a caret) as
 * PNG files without external tools or assets.
 *
 *   npx tsx scripts/make-icons.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

type Rgb = [number, number, number];

interface Shape {
  /** Rounded rectangle in unit coordinates. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  radius: number;
  color: Rgb;
}

const SHAPES: Shape[] = [
  { x0: 0.03, y0: 0.03, x1: 0.97, y1: 0.97, radius: 0.22, color: [0x1f, 0x23, 0x2a] },
  { x0: 0.2, y0: 0.32, x1: 0.72, y1: 0.43, radius: 0.055, color: [0xe6, 0xe3, 0xda] },
  { x0: 0.2, y0: 0.57, x1: 0.5, y1: 0.68, radius: 0.055, color: [0x6f, 0x74, 0x80] },
  { x0: 0.56, y0: 0.52, x1: 0.645, y1: 0.73, radius: 0.03, color: [0x74, 0xc7, 0xb8] },
];

function inside(shape: Shape, x: number, y: number): boolean {
  if (x < shape.x0 || x > shape.x1 || y < shape.y0 || y > shape.y1) return false;
  const cx = Math.min(Math.max(x, shape.x0 + shape.radius), shape.x1 - shape.radius);
  const cy = Math.min(Math.max(y, shape.y0 + shape.radius), shape.y1 - shape.radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= shape.radius ** 2;
}

function render(size: number): Uint8Array {
  const samples = 4;
  const pixels = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          const shape = SHAPES.filter((s) => inside(s, x, y)).at(-1);
          if (!shape) continue;
          r += shape.color[0];
          g += shape.color[1];
          b += shape.color[2];
          a += 1;
        }
      }
      const offset = (py * size + px) * 4;
      if (a > 0) {
        pixels[offset] = Math.round(r / a);
        pixels[offset + 1] = Math.round(g / a);
        pixels[offset + 2] = Math.round(b / a);
      }
      pixels[offset + 3] = Math.round((a / (samples * samples)) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(typed.length + 8);
  out.writeUInt32BE(data.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), typed.length + 4);
  return out;
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    Buffer.from(rgba.subarray(y * size * 4, (y + 1) * size * 4)).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

await mkdir('public/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(`public/icons/icon-${size}.png`, encodePng(size, render(size)));
}
console.log('Wrote public/icons/icon-{16,32,48,128}.png');
