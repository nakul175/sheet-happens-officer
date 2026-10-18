// Fixture process for tests/shutdown.test.ts. Listens with its own http.Server
// and installs the same SIGTERM hook server.js installs on Next's listener.
import http from "node:http";
import { installGracefulShutdown } from "../src/lib/shutdown";

const delayMs = Number(process.env.DELAY_MS ?? "0");
const drainMs = Number(process.env.DRAIN_MS ?? "5000");
const keepAliveMs = Number(process.env.KEEPALIVE_MS ?? "5000");

const server = http.createServer(async (req, res) => {
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
