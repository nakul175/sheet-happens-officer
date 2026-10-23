// APL-2871 AC3: engine.ts (improvePrompt) and logic.ts (offeredRewrite) judge an echo by the one rule in
// src/lib/concierge/echo.ts. Pure functions and a source read; no server, model or database.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { echoKey, isEcho } from "../src/lib/concierge/echo";
import { offeredRewrite } from "../src/components/concierge/logic";

const TYPED = "Move the budget task to Monday";
const NEAR_COPIES = ["move the budget task to monday", "Move the budget task to Monday.", "“Move the budget task to Monday”", "  'Move the budget task to Monday.'  ", "“Move the budget task to Monday”.", "'Move the budget task to Monday'."];
const REWRITES = ["Move the budget review task to Monday 9:00", "Move the budget task to Tuesday", "Move the budget task to Monday..."];

describe("qa:TC missing APL-2871 AC3 one echo rule", () => {
  it("qa:TC missing AC3: echoKey trims, lower-cases, reads curly quotes as straight, drops one wrapping quote pair and one trailing full stop", () => {
    expect(echoKey("  “Move the Budget task to Monday.” ")).toBe("move the budget task to monday");
    expect(echoKey("“Move the Budget task to Monday”.")).toBe("move the budget task to monday");
    expect(echoKey("'Move the Budget task to Monday'.")).toBe("move the budget task to monday");
    expect(echoKey("It’s Monday.")).toBe(echoKey("it's monday"));
    expect(echoKey("Done..")).toBe("done.");
  });

  it.each(NEAR_COPIES)("qa:TC missing AC3: %j is an echo for the server rule and offers nothing on the client", (reply) => {
    expect(isEcho(TYPED, reply)).toBe(true);
    expect(offeredRewrite(TYPED, reply)).toBeNull();
  });

  it.each(REWRITES)("qa:TC missing AC3: %j is a rewrite for the server rule and is offered on the client", (reply) => {
    expect(isEcho(TYPED, reply)).toBe(false);
    expect(offeredRewrite(TYPED, reply)).toEqual({ original: TYPED, draft: reply });
  });

  it("qa:TC missing AC3: engine.ts and logic.ts both use isEcho and no exact-string comparison", () => {
    const engine = readFileSync("src/lib/concierge/engine.ts", "utf8");
    const logic = readFileSync("src/components/concierge/logic.ts", "utf8");
    for (const src of [engine, logic]) expect(src).toMatch(/from "@\/lib\/concierge\/echo"/);
    expect(engine).toMatch(/!isEcho\(clean, improved\)/);
    expect(logic).toMatch(/isEcho\(original, improved\)/);
    expect(engine).not.toMatch(/improved !== clean/);
    expect(logic).not.toMatch(/improved\.trim\(\) === original\.trim\(\)/);
  });
});
