import { frameFits } from "../src/app";
import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { decodePng, encodeRegion } from "../src/png";

// A PNG built here with every filter type, so decoding can be checked exactly.
function makePng(w: number, h: number, channels: 3 | 4, px: (x: number, y: number, c: number) => number): { png: Buffer; data: Uint8Array } {
  const stride = w * channels;
  const data = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < channels; c++) data[y * stride + x * channels + c] = px(x, y, c);
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const f = y % 5;
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const v = data[y * stride + i]!;
      const a = i >= channels ? data[y * stride + i - channels]! : 0;
      const b = y > 0 ? data[(y - 1) * stride + i]! : 0;
      const c = i >= channels && y > 0 ? data[(y - 1) * stride + i - channels]! : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, pr][f]!;
      raw[y * (stride + 1) + 1 + i] = (v - pred) & 0xff;
    }
  }
  // Reuse the encoder's chunk layout by encoding a full region, then swap in our IDAT.
  const base = encodeRegion({ width: w, height: h, channels, data }, 0, 0, w, h);
  const idatAt = base.indexOf("IDAT") - 4;
  const len = base.readUInt32BE(idatAt);
  const z = deflateSync(raw);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(z.length, 0);
  head.write("IDAT", 4, "latin1");
  const crc = Buffer.alloc(4); // decoder doesn't check CRCs
  return { png: Buffer.concat([base.subarray(0, idatAt), head, z, crc, base.subarray(idatAt + 12 + len)]), data };
}

for (const channels of [3, 4] as const) {
  test(`decodes all five filters (${channels} channels)`, () => {
    const { png, data } = makePng(29, 17, channels, (x, y, c) => (x * 31 + y * 17 + c * 101 + ((x * y) % 7) * 23) & 0xff);
    const r = decodePng(png)!;
    expect(r.width).toBe(29);
    expect(r.height).toBe(17);
    expect(r.channels).toBe(channels);
    expect(Buffer.from(r.data).equals(Buffer.from(data))).toBe(true);
  });

  test(`a region round-trips (${channels} channels)`, () => {
    const { png } = makePng(40, 30, channels, (x, y, c) => (x * 5 + y * 3 + c) & 0xff);
    const r = decodePng(png)!;
    const tile = decodePng(encodeRegion(r, 7, 4, 20, 11))!;
    expect([tile.width, tile.height]).toEqual([20, 11]);
    for (let y = 0; y < 11; y++)
      for (let x = 0; x < 20; x++)
        for (let c = 0; c < channels; c++) expect(tile.data[(y * 20 + x) * channels + c]).toBe(r.data[((y + 4) * 40 + x + 7) * channels + c]);
  });
}

test("unsupported PNGs are refused, not misread", () => {
  expect(decodePng(Buffer.from("not a png"))).toBeNull();
});

test("a screencast frame must have its viewport's shape", () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b.toString("base64");
  };
  expect(frameFits(png(780, 560), { w: 780, h: 560 })).toBe(true);
  expect(frameFits(png(390, 280), { w: 780, h: 560 })).toBe(true); // scaled down to fit the screencast
  expect(frameFits(png(780, 561), { w: 780, h: 560 })).toBe(true); // rounding
  // The old viewport's picture, scaled to the new screencast (seen after a re-attach at a smaller size).
  expect(frameFits(png(780, 486), { w: 780, h: 560 })).toBe(false);
  expect(frameFits("not a png", { w: 780, h: 560 })).toBe(true);
  // Very wide and short (160x4 cells at --scale 0.75: 1840x53 CSS px, frames 1380x40) and tall and narrow.
  expect(frameFits(png(1380, 40), { w: 1840, h: 53 })).toBe(true);
  expect(frameFits(png(40, 1380), { w: 53, h: 1840 })).toBe(true);
  expect(frameFits(png(1380, 60), { w: 1840, h: 53 })).toBe(false);
});
