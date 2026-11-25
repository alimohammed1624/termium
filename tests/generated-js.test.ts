import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * JavaScript sent to pages is written as template literals, where `\s`
 * means just "s" (a regex in it needs `\\s`): such a slip once made a
 * check strip trailing "s" letters. Every template literal in src/ (but
 * String.raw ones) is checked for a lone backslash before a regex class.
 */
function templates(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let i = 0;
  const line = (at: number) => src.slice(0, at).split("\n").length;
  const skipString = (q: string) => {
    for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
  };
  const template = (raw: boolean): void => {
    const start = i;
    let text = "";
    for (i++; i < src.length && src[i] !== "`"; i++) {
      if (src[i] === "\\") {
        text += src[i]! + src[i + 1]!;
        i++;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        // An expression: skip it (it may hold strings and templates of its own).
        let depth = 0;
        for (i++; i < src.length; i++) {
          const c = src[i];
          if (c === "{") depth++;
          else if (c === "}" && --depth === 0) break;
          else if (c === "'" || c === '"') skipString(c);
          else if (c === "`") template(false);
        }
        text += "${…}";
      } else text += src[i];
    }
    if (!raw) out.push({ text, line: line(start) });
  };
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i);
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i) + 1;
    else if (c === "'" || c === '"') skipString(c);
    else if (c === "`") template(src.slice(Math.max(0, i - 10), i).endsWith("String.raw"));
    if (i < 0) break;
  }
  return out;
}

test("no lone backslash before a regex class in templates of generated JS", () => {
  const dir = join(import.meta.dir, "..", "src");
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    for (const t of templates(readFileSync(join(dir, f), "utf8"))) {
      const m = t.text.match(/(?<!\\)\\[sdwbSDWB]/);
      if (m) bad.push(`${f}:${t.line}: ${t.text.slice(Math.max(0, m.index! - 30), m.index! + 10)}`);
    }
  }
  expect(bad).toEqual([]);
});
