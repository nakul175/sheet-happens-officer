import net from "node:net";
import { performance } from "node:perf_hooks";

// SHO-2760 owner decision: never accepted; ECONNREFUSED within one SYN retry (1.2 s).
export const REFUSAL_LIMIT_MS = 1200;
export const refusalAccepted = (result) => result?.state === "refused"
  && Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0 && result.elapsedMs <= REFUSAL_LIMIT_MS;

export function probeRefusal(port) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ port, host: "127.0.0.1" });
    let settled = false;
    let timer;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsedMs = performance.now() - started;
      socket.destroy();
      resolve({ state, elapsedMs });
    };
    timer = setTimeout(() => finish("hung"), REFUSAL_LIMIT_MS);
    socket.once("connect", () => finish("open"));
    socket.once("error", (err) => finish(err.code === "ECONNREFUSED" ? "refused" : err.code ?? "error"));
  });
}
