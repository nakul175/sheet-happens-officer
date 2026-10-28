import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { probeRefusal, refusalAccepted } from "./refusal-probe.mjs";

test("SHO-2760 accepts one SYN retry only within1200ms and never an accepted connection", () => {
  for (const elapsedMs of [0, 1057, 1200]) assert.equal(refusalAccepted({ state: "refused", elapsedMs }), true);
  for (const elapsedMs of [-1, 1200.001, Infinity, NaN, undefined]) assert.equal(refusalAccepted({ state: "refused", elapsedMs }), false);
  for (const state of ["open", "hung", "ECONNRESET", "error"]) assert.equal(refusalAccepted({ state, elapsedMs: 0 }), false);
});

test("SHO-2760 probe distinguishes a real accepted socket from a refused socket and measures each", async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const open = await probeRefusal(port);
    assert.equal(open.state, "open");
    assert.equal(refusalAccepted(open), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const refused = await probeRefusal(port);
  assert.equal(refused.state, "refused");
  assert.equal(refusalAccepted(refused), true);
});
