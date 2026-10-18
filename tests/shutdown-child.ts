// Fixture process for tests/shutdown.test.ts. Listens with its own http.Server
// and installs the same SIGTERM hook server.js installs on Next's listener.
import fs from "node:fs";
import http from "node:http";
import { installGracefulShutdown } from "../src/lib/shutdown";

const delayMs = Number(process.env.DELAY_MS ?? "0");
const drainMs = Number(process.env.DRAIN_MS ?? "5000");
const keepAliveMs = Number(process.env.KEEPALIVE_MS ?? "5000");

const server = http.createServer(async (req, res) => {
  if (req.url === "/spin") {
    // Block the event loop so clients that connect now sit in the kernel queue,
    // which is the gap a slow 2-vCPU box leaves between accept and dispatch.
    fs.writeSync(1, "spin\n");
    const spinMs = Number(process.env.SPIN_MS ?? "0");
    const end = Date.now() + (Number.isFinite(spinMs) ? spinMs : 0);
    while (Date.now() < end) {
      // Keep the loop honest so it is not folded away.
      Math.sqrt(end);
    }
    res.end("done");
    return;
  }
  if (req.url === "/slow") {
    process.stdout.write("hit\n");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  res.end("done");
});
server.keepAliveTimeout = Number.isFinite(keepAliveMs) && keepAliveMs > 0 ? keepAliveMs : 5000;

server.listen(0, "127.0.0.1", () => {
  installGracefulShutdown({
    drainMs,
    disconnect: async () => {
      process.stdout.write("prisma disconnected\n");
    },
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  process.stdout.write(`ready ${port}\n`);
});
