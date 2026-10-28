// W278 (QA): "the view swapped to B promptly" must be measured in time, not in samples.
//
// e2e/useGet-path-reset.spec.ts records the page on every requestAnimationFrame AND on a 50 ms
// setInterval, into one array (`watchAndGo`, `:86-92`). The number of records that pile up before
// project B's skeleton appears is therefore a function of the renderer's frame cadence as much as of
// how long the navigation took: a machine that renders faster, or a first navigation that still has
// a route to compile, produces MORE records for the SAME latency.
//
// At HEAD the assertion was `expect(firstBusy).toBeLessThan(15)` - a sample index compared to a bare
// constant. It went red at HEAD with 25 while every product assertion around it (skeleton present,
// no frame of B showing A's items, same document) held, and it passed on the very next run of the
// same file and on a run of the file alone. A bound that moves with the frame rate cannot tell a
// slow first navigation from a regression; it also cannot fail for the reason its message names.
//
// The fix stamps each sample with its elapsed time from the navigation and bounds THAT. This guard
// pins the shape, so the sample index cannot creep back in as a latency proxy.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SPEC = path.join(process.cwd(), "e2e/useGet-path-reset.spec.ts");
const source = readFileSync(SPEC, "utf8");

/** The single line that carries the promptness assertion. */
function promptLine(): string {
  const line = source.split("\n").find((l) => l.includes("view swapped to B promptly"));
  if (!line) throw new Error("e2e/useGet-path-reset.spec.ts has no 'view swapped to B promptly' assertion");
  return line;
}

describe("useGet-path-reset promptness bound", () => {
  it("does not compare a sample index to a bare constant", () => {
    // The regression this pins: `expect(firstBusy, "... prompt").toBeLessThan(15)`.
    const line = promptLine();
    expect(line, `a sample index cannot bound latency: ${line.trim()}`).not.toMatch(/firstBusy\s*,\s*[^)]*prompt/i);
  });

  it("bounds the elapsed time of the first busy sample", () => {
    const line = promptLine();
    expect(line, `the promptness assertion must read the sample's stamp: ${line.trim()}`).toMatch(/\.t\b/);
    expect(line, `the promptness assertion must be a finite time bound: ${line.trim()}`).toMatch(/toBeLessThan\(\d+\)/);
  });

  it("stamps every sample with one clock started at the navigation", () => {
    // One `start`, read by the single `record()` that both the rAF loop and the interval call.
    expect(source, "watchAndGo must start a clock").toMatch(/const start = performance\.now\(\)/);
    expect(source, "each sample must carry its elapsed time").toMatch(/t:\s*Math\.round\(performance\.now\(\) - start\)/);
    expect(source, "the frame type must declare the stamp").toMatch(/__shoFrames\?: \{ t: number;/);
  });
});
