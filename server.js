/* eslint-disable @typescript-eslint/no-require-imports -- env is set before Next loads; require keeps that order. */
// Production entry. systemd runs this instead of `next start`.
//
// next start registers SIGTERM inside start-server.js's listening callback, before
// instrumentation, and that handler closes the HTTP server (Node then destroys
// accepted-but-unparsed sockets) and exits 143. NEXT_MANUAL_SIG_HANDLE disables it,
// but only if it is set before that callback. This file sets it before loading Next,
// creates the listening http.Server itself, and hands that server to the drain.
//
// Bind: 127.0.0.1:3000, overridable with SHO_BIND_HOST and PORT (PORT=0 picks a free port).
// SHUTDOWN_TEST_SLOW_MS is a test-only seam. When it is set, GET /__shutdown_slow holds
// the socket open for that many milliseconds, and SHUTDOWN_DRAIN_MS is taken as given
// (the 10–25s clamp still applies when the seam is off).

process.env.NEXT_MANUAL_SIG_HANDLE = "true";

const http = require("node:http");
const next = require("next");
const { installGracefulShutdown } = require("./src/lib/shutdown.ts");

function bindPort() {
  const raw = process.env.PORT;
  if (raw == null || raw.trim() === "") return 3000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return 3000;
  return n;
}

const port = bindPort();
const hostname = process.env.SHO_BIND_HOST || "127.0.0.1";
const dev = process.env.NODE_ENV === "development";
const slowMs = Number(process.env.SHUTDOWN_TEST_SLOW_MS || "0");
const testDrain = Number(process.env.SHUTDOWN_DRAIN_MS || "");

const app = next({ dev, hostname, port: port || 3000 });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const server = http.createServer((req, res) => {
      if (slowMs > 0 && req.url?.split("?")[0] === "/__shutdown_slow") {
        process.stdout.write("sho-hit\n");
        res.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
        res.write("hit\n");
        setTimeout(() => res.end("done\n"), slowMs);
        return;
      }
      handle(req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      });
    });

    const drainMs = slowMs > 0 && Number.isFinite(testDrain) && testDrain > 0 ? testDrain : undefined;
    installGracefulShutdown({
      servers: [server],
      drainMs,
      onStoppedAccepting:
        slowMs > 0
          ? () => {
              process.stdout.write("sho unlistened\n");
            }
          : undefined,
    });

    server.on("error", (err) => {
      console.error(err);
      process.exit(1);
    });
    server.listen(port, hostname, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      process.stdout.write(`sho ready ${actual}\n`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
