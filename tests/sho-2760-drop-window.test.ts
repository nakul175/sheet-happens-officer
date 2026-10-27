import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("SHO-2760 shutdown telemetry", () => {
  it("measures the SYN drop window in the native signal path", () => {
    const source = readFileSync("src/lib/sho-accept.c", "utf8");
    expect(source).toContain("clock_gettime(CLOCK_MONOTONIC, &drop_start)");
    expect(source).toContain("clock_gettime(CLOCK_MONOTONIC, &drop_end)");
    expect(source).toContain("int sho_drop_window_us(void)");
  });

  it("logs the measured window on every native shutdown", () => {
    const source = readFileSync("src/lib/shutdown.ts", "utf8");
    expect(source).toContain('lib.func("int sho_drop_window_us(void)")');
    expect(source).toContain("graceful shutdown: post-SIGTERM SYN drop window");
  });
});
