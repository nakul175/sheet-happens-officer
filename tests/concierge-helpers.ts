// Shared pieces for the concierge tests: a scripted fake model and small builders.
// These tests call src/lib directly (same DATABASE_URL as the server) and use the HTTP helpers to set up people and work.
import { afterEach, beforeEach } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { setFakeModel, type ContentBlock, type ModelRequest } from "../src/lib/model";
import { clearProviderDown } from "../src/lib/concierge/limits";
import type { Actor } from "../src/lib/access";
import type { Account } from "./helpers";

export const db = new PrismaClient();
export const actor = (a: Account, orgRole: Actor["orgRole"] = "MEMBER"): Actor => ({ id: a.id, orgRole });

let n = 0;
export const tu = (name: string, input: Record<string, unknown>): ContentBlock => ({ type: "tool_use", id: `tu_${n++}`, name, input });
export const say = (text: string): ContentBlock => ({ type: "text", text });
export type Step = (req: ModelRequest) => ContentBlock[];

/** Each model call in a turn plays the next step. Cost per call is tiny and fixed. */
export function script(...steps: Step[]) {
  setFakeModel((req, call) => ({
    content: steps[call - 1]?.(req) ?? [say("ok")],
    stopReason: "end_turn",
    usage: { input: 1000, output: 100, cacheWrite: 0, cacheRead: 0 },
  }));
}

/** The JSON a tool returned in the latest tool_result of the request. */
export function lastData(req: ModelRequest): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const c = req.messages[i].content;
    if (Array.isArray(c)) {
      const r = c.find((b) => b.type === "tool_result");
      if (r && r.type === "tool_result") {
        try { return JSON.parse(r.content).untrusted_data ?? { error: r.content }; } catch { return { error: r.content }; }
      }
    }
  }
  return {};
}
export const lastResultText = (req: ModelRequest) => {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const c = req.messages[i].content;
    if (Array.isArray(c)) { const r = c.find((b) => b.type === "tool_result"); if (r && r.type === "tool_result") return r.content; }
  }
  return "";
};

/** Fake provider on, owner approval on, no waiting between retries. */
export function useFakeModel() {
  beforeEach(() => {
    process.env.MODEL_PROVIDER = "fake";
    process.env.MODEL_DATA_APPROVED = "true";
    process.env.MODEL_RETRY_DELAY_MS = "0";
    delete process.env.MONTHLY_CEILING_USD;
    delete process.env.WEEKLY_MESSAGE_CAP;
    delete process.env.MODEL_NAME;
    clearProviderDown();
    setFakeModel(null);
  });
  afterEach(() => {
    setFakeModel(null);
    clearProviderDown();
    delete process.env.MODEL_PROVIDER;
    delete process.env.MODEL_DATA_APPROVED;
    delete process.env.MODEL_RETRY_DELAY_MS;
    delete process.env.MONTHLY_CEILING_USD;
    delete process.env.WEEKLY_MESSAGE_CAP;
    delete process.env.MODEL_NAME;
  });
}

/** 10:00 India time on Monday 17 March 2031: a Monday far from any real data. */
export const MONDAY = new Date(Date.UTC(2031, 2, 17, 4, 30));
export const istInstant = (y: number, m: number, d: number, h = 0, min = 0, s = 0) => new Date(Date.UTC(y, m - 1, d, h, min, s) - 5.5 * 3600_000);
