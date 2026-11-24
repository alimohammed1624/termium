import { expect, test } from "bun:test";
import { FrameReader, jsonFrame, outputFrame, type Frame } from "../src/session";

test("frames come out whole however the stream is cut", () => {
  const big = "x".repeat(300_000) + "é";
  const stream = Buffer.concat([jsonFrame({ t: "hello", n: 1 }), outputFrame(big, 7), jsonFrame({ t: "ack", seq: 7 }), outputFrame("", 0)]);
  for (const size of [1, 3, 4096, 65_537, stream.length]) {
    const got: Frame[] = [];
    const r = new FrameReader((f) => got.push(f));
    for (let i = 0; i < stream.length; i += size) r.push(stream.subarray(i, i + size));
    expect(got.length).toBe(4);
    expect(got[0]).toEqual({ type: 1, msg: { t: "hello", n: 1 } });
    expect(got[1]).toEqual({ type: 2, seq: 7, data: big });
    expect(got[2]).toEqual({ type: 1, msg: { t: "ack", seq: 7 } });
    expect(got[3]).toEqual({ type: 2, seq: 0, data: "" });
  }
});

test("byte-at-a-time input stays linear", () => {
  const stream = Buffer.concat(Array.from({ length: 2000 }, (_, i) => outputFrame("y".repeat(100), i)));
  let n = 0;
  const r = new FrameReader(() => n++);
  const t0 = performance.now();
  for (let i = 0; i < stream.length; i++) r.push(stream.subarray(i, i + 1));
  expect(n).toBe(2000);
  expect(performance.now() - t0).toBeLessThan(2000);
});

test("garbage is refused", () => {
  const r = new FrameReader(() => {});
  expect(() => r.push(Buffer.from([9, 0, 0, 0, 1, 0]))).toThrow();
});
