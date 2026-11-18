// Audit-only TLS front for the built app. Fixed loopback upstream; never bind a public interface.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { request } from 'node:http';

const key = readFileSync(process.env.SHO_AUDIT_TLS_KEY);
const cert = readFileSync(process.env.SHO_AUDIT_TLS_CERT);
const port = Number(process.env.SHO_AUDIT_TLS_PORT || '3443');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid audit TLS port');

const server = createServer({ key, cert }, (incoming, outgoing) => {
  const upstream = request({ hostname: '127.0.0.1', port: 3100, path: incoming.url, method: incoming.method,
    headers: { ...incoming.headers, 'x-forwarded-proto': 'https' } }, reply => {
    outgoing.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(outgoing);
  });
  upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
  incoming.pipe(upstream);
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`audit TLS loopback ready ${port}\n`));
