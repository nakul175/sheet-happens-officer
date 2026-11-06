import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, local2691 } from '../helpers/2691-admin';
import { BASE_URL, expect } from './qa';
import { PW, zzTestData } from '../local-api';

test('SHO-REG-AUTH-01: production session cookie survives reload and replay is denied', async ({ admin }) => {
  if (!local2691) throw new Error('This cookie case requires the guarded local production-mode server.');
  const evidenceDir = 'test-results/auth-session-cookie';
  const context = admin.page.context();
  const cookie = (await context.cookies()).find((item) => item.name === 'sho_session');
  expect(cookie).toBeDefined();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.secure).toBe(true);
  expect(cookie!.sameSite).toBe('Lax');
  expect(cookie!.path).toBe('/');
  expect(cookie!.expires * 1000 - Date.now()).toBeGreaterThan(29 * 86400_000);
  expect(cookie!.expires * 1000 - Date.now()).toBeLessThan(31 * 86400_000);

  await admin.page.goto('/projects');
  await expect(admin.page).not.toHaveURL(/\/signin(?:\?|$)/);
  expect(await admin.page.evaluate(() => document.cookie.includes('sho_session='))).toBe(false);
  const before = await admin.api.get('/api/auth/me');
  expect(before.status).toBe(200);
  await admin.page.reload();
  await expect(admin.page).not.toHaveURL(/\/signin(?:\?|$)/);
  const after = await admin.api.get('/api/auth/me');
  expect(after.status).toBe(200);
  expect(after.json.user.id).toBe(before.json.user.id);
  expect(await admin.page.evaluate(() => document.cookie.includes('sho_session='))).toBe(false);

  const signout = await admin.api.post('/api/auth/signout');
  expect(signout.status).toBe(204);
  await context.addCookies([{ name: cookie!.name, value: cookie!.value, domain: cookie!.domain, path: cookie!.path, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  expect((await admin.api.get('/api/auth/me')).status).toBe(401);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ productionMode: true, httpOnly: true, secure: true, sameSite: 'Lax', path: '/', expiryAbout30Days: true, notVisibleToDocumentCookie: true, identitySurvivedReload: true, replayDeniedAfterSignout: true }, null, 2));
  writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ sessionRevoked: true, cleanup: true }, null, 2));
});

test('SHO-REG-AUTH-01: a Member session uses a Secure cookie over real loopback HTTPS', async ({ browser }) => {
  if (!local2691) throw new Error('HTTPS Member case requires the guarded local production-mode server.');
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) || !/^\/sho_test(?:_[\w-]+)?$/.test(database.pathname) || process.env.TASKBOARD_URL !== BASE_URL)
    throw new Error('HTTPS Member case requires one loopback app and a synthetic sho_test database.');

  const fixture = zzTestData('auth01-https');
  const tlsDir = mkdtempSync(path.join(tmpdir(), 'sho-auth01-tls-'));
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  const key = path.join(tlsDir, 'key.pem');
  const cert = path.join(tlsDir, 'cert.pem');
  let server: ReturnType<typeof createHttpsServer> | undefined;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
    server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (incoming, outgoing) => {
      const upstream = httpRequest(new URL(incoming.url ?? '/', BASE_URL), {
        method: incoming.method,
        headers: { ...incoming.headers, host: new URL(BASE_URL).host, 'x-forwarded-proto': 'https' },
      }, (reply) => { outgoing.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(outgoing); });
      upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.pipe(upstream);
    });
    const listener = server;
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('No owned TLS port');
    const origin = `https://127.0.0.1:${address.port}`;
    const member = await fixture.person('member');
    expect((await member.c.post('/api/auth/signout')).status).toBe(204);
    context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
    const signedIn = await context.request.post('/api/auth/signin', { data: { email: member.email, password: PW } });
    expect(signedIn.status()).toBe(200);
    expect((await signedIn.json()).user.orgRole).toBe('MEMBER');
    const cookie = (await context.cookies(origin)).find((item) => item.name === 'sho_session');
    expect(cookie).toBeDefined();
    expect(cookie!.secure).toBe(true);
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('Lax');
    const page = await context.newPage();
    await page.goto('/projects');
    await expect(page).not.toHaveURL(/\/signin(?:\?|$)/);
    expect(await page.evaluate(() => document.cookie.includes('sho_session='))).toBe(false);
    const before = await context.request.get('/api/auth/me');
    expect(before.status()).toBe(200);
    expect((await before.json()).user.id).toBe(member.id);
    await page.reload();
    const after = await context.request.get('/api/auth/me');
    expect(after.status()).toBe(200);
    expect((await after.json()).user.id).toBe(member.id);
    expect((await context.request.post('/api/auth/signout')).status()).toBe(204);
    await context.addCookies([{ name: cookie!.name, value: cookie!.value, domain: cookie!.domain, path: cookie!.path, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    expect((await context.request.get('/api/auth/me')).status()).toBe(401);
    mkdirSync('test-results/auth-session-https', { recursive: true });
    writeFileSync('test-results/auth-session-https/verification.json', JSON.stringify({ ownedLoopbackHttps: true, verifiedMember: true, secure: true, httpOnly: true, sameSite: 'Lax', protectedReload: true, replayDenied: true }, null, 2));
  } finally {
    if (context) await context.close();
    const closingServer = server;
    if (closingServer?.listening) {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve) => closingServer.close(() => resolve()));
    }
    rmSync(tlsDir, { recursive: true, force: true });
    const cleanup = await fixture.cleanUp();
    expect(cleanup).toEqual([]);
    mkdirSync('test-results/auth-session-https', { recursive: true });
    writeFileSync('test-results/auth-session-https/cleanup.json', JSON.stringify({ ownedProxyStopped: true, tlsFilesRemoved: true, memberDeactivated: true, cleanup: true }, null, 2));
  }
});
