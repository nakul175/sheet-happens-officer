// Fixture for the SHO-2689 F7 regression: the drain's real prisma disconnect path.
//
// tests/shutdown-child.ts injects a fake `disconnect`, so nothing exercised
// src/lib/shutdown.ts's own disconnectPrisma() — which is why the "@/lib/db" alias
// (unresolvable under `node server.js` type stripping) shipped. This child passes no
// `disconnect`, so the real one runs, and the parent asserts the drain stayed clean.
//
// Run it exactly the way systemd runs the server: plain `node`, no tsx.
import http from "node:http";
import { installGracefulShutdown } from "../src/lib/shutdown.ts";

const server = http.createServer(async (req, res) => {
  if (req.url === "/slow") {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.DELAY_MS ?? "50")));
  }
  res.end("done");
});

server.keepAliveTimeout = Number(process.env.KEEPALIVE_MS ?? "5000");

server.listen(0, "127.0.0.1", () => {
  installGracefulShutdown({ servers: [server], drainMs: 5000 });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  process.stdout.write(`ready ${port}\n`);
});
