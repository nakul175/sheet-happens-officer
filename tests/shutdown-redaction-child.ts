import http from "node:http";
import { installGracefulShutdown } from "@/lib/shutdown";

async function main() {
const marker = "ZZ-TEST-PRIVATE-SHUTDOWN-MARKER";
const server = http.createServer((_req, res) => res.end("ok"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const done = new Promise<void>((resolve) => {
  installGracefulShutdown({
    servers: [server],
    drainMs: 1000,
    disconnect: async () => { throw new Error(marker); },
    log: () => resolve(),
    exit: () => {},
  });
});
process.emit("SIGTERM");
await done;
process.stdout.write("shutdown completed\n");
process.exit(0);
}
void main();
