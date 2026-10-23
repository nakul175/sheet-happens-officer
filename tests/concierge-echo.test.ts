// APL-2871 AC3: engine.ts (improvePrompt) and logic.ts (offeredRewrite) judge an echo by the one rule in
// src/lib/concierge/echo.ts. Pure functions and a source read; no server, model or database.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { echoKey, isEcho } from "../src/lib/concierge/echo";
import { offeredRewrite } from "../src/components/concierge/logic";

const TYPED = "Move the budget task to Monday";
// SHO-3010 AC1: the ticket's own failing case is the typed text in STRAIGHT DOUBLE quotes with one full stop after the
// closing quote, so all four quote styles appear here that way as well as with the stop inside the quotes.
const NEAR_COPIES = ["move the budget task to monday", "Move the budget task to Monday.", "“Move the budget task to Monday”", "  'Move the budget task to Monday.'  ", "\"Move the budget task to Monday\".", "“Move the budget task to Monday”.", "'Move the budget task to Monday'.", "‘Move the budget task to Monday’.", "“Move the budget task to Monday.”."];
const REWRITES = ["Move the budget review task to Monday 9:00", "Move the budget task to Tuesday", "Move the budget task to Monday..."];

// SHO-3010 AC1 says "the typed text in quotes plus one full stop, and every near-copy". A near-copy is the typed
// text with a cosmetic difference only (case, quotes, a trailing stop, trailing space), so isEcho is true and no
// rewrite is offered. One extra or missing word, or different terminal punctuation, is a real change: a rewrite.
// The thread's near-copy list is spelled out here, one row per shape, so a regression in any single one fails.
const SHAPES: { label: string; reply: string; echo: boolean }[] = [
  { label: "bare text, no stop", reply: TYPED, echo: true },
  { label: "missing stop, different case", reply: "move the budget task to monday", echo: true },
  { label: "different case with a stop", reply: "MOVE THE BUDGET TASK TO MONDAY.", echo: true },
  { label: "trailing space", reply: `${TYPED}   `, echo: true },
  { label: "leading and trailing space", reply: `  ${TYPED}  `, echo: true },
  { label: "a space before the stop", reply: `${TYPED} .`, echo: true },
  { label: "quoted, no stop", reply: `"${TYPED}"`, echo: true },
  { label: "quoted, stop after the closing quote", reply: `"${TYPED}".`, echo: true },
  { label: "quoted, stop inside the quotes", reply: `"${TYPED}."`, echo: true },
  { label: "quoted, stop inside and after it", reply: `"${TYPED}.".`, echo: true },
  { label: "curly quotes, stop after", reply: `\u201c${TYPED}\u201d.`, echo: true },
  { label: "a space between the quote and the stop", reply: `"${TYPED}" .`, echo: true },
  { label: "extra word", reply: "Move the budget task to Monday please", echo: false },
  { label: "extra word, quoted with a stop", reply: `"Move the budget task to Monday please".`, echo: false },
  { label: "missing word", reply: "Move the budget task Monday", echo: false },
  { label: "comma inside the quotes", reply: `"${TYPED},"`, echo: false },
  { label: "a different day", reply: "Move the budget task to Tuesday", echo: false },
];

// Outside the rule AC1 states. echoKey reads ONE trailing full stop, so a doubled stop is kept ("Done.." keeps its
// second stop, asserted above) and a "!" or "?" is a change, not the echo. Both read as rewrites today. Pinned here
// so the limit is visible rather than accidental; W120-REPORT.md records that a maximal reading of "every near-copy"
// would call the terminal-punctuation rows echoes. Changing them needs a ticket, not a silent test edit.
const OUTSIDE_THE_RULE: { label: string; reply: string }[] = [
  { label: "two stops", reply: `${TYPED}..` },
  { label: "an exclamation mark inside the quotes", reply: `"${TYPED}!"` },
  { label: "a question mark inside the quotes", reply: `"${TYPED}?"` },
];

describe("qa:TC missing APL-2871 AC3 one echo rule", () => {
  it("qa:TC missing AC3: echoKey trims, lower-cases, reads curly quotes as straight, drops one wrapping quote pair and one trailing full stop", () => {
    expect(echoKey("  “Move the Budget task to Monday.” ")).toBe("move the budget task to monday");
    // SHO-3010 AC1: the ticket's verbatim pair, straight double quotes with the full stop after the closing quote.
    expect(echoKey("\"Move the Budget task to Monday\".")).toBe("move the budget task to monday");
    expect(echoKey("“Move the Budget task to Monday”.")).toBe("move the budget task to monday");
    expect(echoKey("'Move the Budget task to Monday'.")).toBe("move the budget task to monday");
    expect(echoKey("‘Move the Budget task to Monday’.")).toBe("move the budget task to monday");
    expect(echoKey("“Move the Budget task to Monday.”.")).toBe("move the budget task to monday");
    expect(echoKey("It’s Monday.")).toBe(echoKey("it's monday"));
    expect(echoKey("Done..")).toBe("done.");
  });

  it.each(NEAR_COPIES)("qa:TC missing AC3: %j is an echo for the server rule and offers nothing on the client", (reply) => {
    expect(isEcho(TYPED, reply)).toBe(true);
    expect(offeredRewrite(TYPED, reply)).toBeNull();
  });

  it.each(SHAPES)("qa:TC missing SHO-3010 AC1: $label is judged an echo when the shape says so and nothing is offered", ({ reply, echo }) => {
    expect(isEcho(TYPED, reply)).toBe(echo);
    expect(offeredRewrite(TYPED, reply) === null).toBe(echo);
  });

  it.each(OUTSIDE_THE_RULE)("qa:TC missing SHO-3010 AC1 (limit): $label reads as a change, so the reply is offered", ({ reply }) => {
    expect(isEcho(TYPED, reply)).toBe(false);
    expect(offeredRewrite(TYPED, reply)).toEqual({ original: TYPED, draft: reply });
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
