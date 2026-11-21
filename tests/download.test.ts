import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeName, safeFileName } from "../src/app";

describe("download names", () => {
  test("suggested names are made safe", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..\\..\\boot.ini")).toBe("boot.ini");
    expect(safeFileName(".bashrc")).toBe("bashrc");
    expect(safeFileName("a\x1b[31mb.txt")).toBe("a[31mb.txt");
    expect(safeFileName("")).toBe("download");
  });

  test("existing files are never replaced", () => {
    const dir = mkdtempSync(join(tmpdir(), "termium-test-"));
    try {
      expect(freeName(dir, "report.pdf")).toBe(join(dir, "report.pdf"));
      writeFileSync(join(dir, "report.pdf"), "x");
      expect(freeName(dir, "report.pdf")).toBe(join(dir, "report (1).pdf"));
      writeFileSync(join(dir, "report (1).pdf"), "x");
      expect(freeName(dir, "report.pdf")).toBe(join(dir, "report (2).pdf"));
      writeFileSync(join(dir, "archive"), "x");
      expect(freeName(dir, "archive")).toBe(join(dir, "archive (1)"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
