// Just enough PNG to cut a frame into tiles: decode 8-bit RGB/RGBA
// non-interlaced images (what Chromium produces), and encode a region of
// one as a new PNG.

import { deflateSync, inflateSync } from "node:zlib";

export interface Raster {
  width: number;
  height: number;
  channels: 3 | 4;
  /** Unfiltered rows, width * channels bytes each. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes a PNG, or null if it's a kind this doesn't handle. */
export function decodePng(buf: Uint8Array): Raster | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 8 || !b.subarray(0, 8).equals(SIGNATURE)) return null;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 4;
  const idat: Buffer[] = [];
  for (let pos = 8; pos + 8 <= b.length; ) {
    const len = b.readUInt32BE(pos);
    const type = b.toString("latin1", pos + 4, pos + 8);
    const body = b.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) return null;
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height || idat.length === 0) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const data = new Uint8Array(height * stride);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= bpp ? data[dst + x - bpp]! : 0;
      const up = y > 0 ? data[prev + x]! : 0;
      let out: number;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + up; break;
        case 3: out = v + ((a + up) >> 1); break;
        case 4: {
          const c = x >= bpp && y > 0 ? data[prev + x - bpp]! : 0;
          const p = a + up - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - c);
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
          break;
        }
        default:
          return null;
      }
      data[dst + x] = out & 0xff;
    }
  }
  return { width, height, channels, data };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Buffer[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([head.subarray(4), body]), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encodes the w x h region of `r` at (x, y) as a PNG (clamped to the image). */
export function encodeRegion(r: Raster, x: number, y: number, w: number, h: number): Buffer {
  x = Math.max(0, Math.min(r.width - 1, x));
  y = Math.max(0, Math.min(r.height - 1, y));
  w = Math.max(1, Math.min(r.width - x, w));
  h = Math.max(1, Math.min(r.height - y, h));
  const ch = r.channels;
  const rowLen = w * ch;
  const raw = Buffer.alloc(h * (rowLen + 1));
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * r.width + x) * ch;
    raw[row * (rowLen + 1)] = 0; // filter: none
    raw.set(r.data.subarray(src, src + rowLen), row * (rowLen + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = ch === 4 ? 6 : 2;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}
