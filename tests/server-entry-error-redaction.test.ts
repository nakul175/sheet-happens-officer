import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

const marker = "ZZ-TEST-PRIVATE-REQUEST-MARKER";

type ResponseSink = { headersSent: boolean; statusCode: number; end: (body: string) => void };
type RequestHandler = (req: { url: string }, res: ResponseSink) => void;

async function entry(prepareFails = false) {
  let handler: RequestHandler | null = null;
  const events = new Map<string, (err: Error) => void>();
  const logs: unknown[][] = [];
  const exits: number[] = [];
  const server = {
    on: (event: string, callback: (err: Error) => void) => { events.set(event, callback); },
    listen: (_port: number, _host: string, ready: () => void) => ready(),
    address: () => ({ port: 3100 }),
  };
  const app = {
    getRequestHandler: () => () => Promise.reject(new Error(marker)),
    prepare: async () => { if (prepareFails) throw new Error(marker); },
  };
  const requireStub = (name: string) => {
    if (name === "node:http") return { createServer: (fn: RequestHandler) => { handler = fn; return server; } };
    if (name === "next") return () => app;
    if (name === "./src/lib/shutdown.ts") return { installGracefulShutdown: () => {} };
    throw new Error(`Unexpected dependency ${name}`);
  };
  vm.runInNewContext(readFileSync("server.js", "utf8"), {
    require: requireStub,
    process: { env: { NODE_ENV: "production", PORT: "3100" }, stdout: { write: () => {} }, exit: (code: number) => { exits.push(code); } },
    console: { error: (...args: unknown[]) => logs.push(args) },
    setTimeout,
  });
  await Promise.resolve();
  await Promise.resolve();
  return { handler: handler as RequestHandler | null, events, logs, exits };
}

const logged = (logs: unknown[][]) => logs.flat().map(String).join(" ");

it("production entry hides thrown request details in logs and response", async () => {
  const state = await entry();
  expect(state.handler).not.toBeNull();
  let body = "";
  state.handler!({ url: "/api/test" }, { headersSent: false, statusCode: 200, end: (value: string) => { body = value; } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(body).toBe("Internal Server Error");
  expect(logged(state.logs)).not.toContain(marker);
});

it("production entry hides listen error details and exits unsuccessfully", async () => {
  const state = await entry();
  state.events.get("error")!(new Error(marker));
  expect(state.exits).toEqual([1]);
  expect(logged(state.logs)).not.toContain(marker);
});

it("production entry hides preparation error details and exits unsuccessfully", async () => {
  const state = await entry(true);
  expect(state.exits).toEqual([1]);
  expect(logged(state.logs)).not.toContain(marker);
});
