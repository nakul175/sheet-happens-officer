// Independent rollback smoke for a previous release that predates verify-release.mjs.
// Keep this separate from the candidate verifier: a broken candidate verifier must
// not prevent us from confirming that the previous app is serving again.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');
function check(ok, code) { if (!ok) throw new Error(code); }

export async function verifyPreviousRelease({ root, expected, origin, pid, procRoot = '/proc' }) {
  check(/^[0-9a-f]{40}$/.test(expected), 'INVALID_SHA');
  const url = new URL(origin);
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'INVALID_ORIGIN');
  const request = (route, options = {}) => fetch(new URL(route, url), { redirect: 'manual', signal: AbortSignal.timeout(5000), ...options });
  check((await readFile(path.join(root, 'COMMIT'), 'utf8')).trim() === expected, 'COMMIT_MISMATCH');
  check(/^\d+$/.test(String(pid)) && Number(pid) > 0, 'INVALID_PID');
  check(await realpath(path.join(procRoot, String(pid), 'cwd')) === await realpath(root), 'PROCESS_CWD_MISMATCH');
  check(Boolean((await readFile(path.join(root, '.next/BUILD_ID'), 'utf8')).trim()), 'BUILD_ID_MISSING');
  const manifest = JSON.parse(await readFile(path.join(root, '.next/server/app-paths-manifest.json'), 'utf8'));
  for (const route of ['authorize', 'token', 'userinfo', 'status']) check(Boolean(manifest[`/api/suite/${route}/route`]), `SUITE_${route.toUpperCase()}_MISSING`);
  const health = await request('/api/health');
  check(health.status === 200, 'HEALTH_STATUS');
  const body = await health.json();
  check(body.ok === true && body.release === expected, 'HEALTH_IDENTITY');
  for (const client of ['accounts', 'bugoff']) {
    const redirect = client === 'accounts' ? 'https://accounts.aplyd.org/bridge/callback' : 'https://bugoff.aplyd.org/api/auth/callback/aplyd';
    const query = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'c'.repeat(43), state: 's'.repeat(32) });
    const response = await request(`/api/suite/authorize?${query}`);
    check(response.status === 302, 'AUTHORIZE_STATUS');
    const location = new URL(response.headers.get('location') ?? '', url);
    check(location.origin === 'https://sheethappensofficer.aplyd.org' && location.pathname === '/signin', 'AUTHORIZE_REDIRECT');
  }
  for (const route of ['userinfo', 'token', 'status']) {
    const options = route === 'userinfo' ? {} : route === 'token'
      ? { method: 'POST', body: new URLSearchParams({ client_id: 'accounts', client_secret: 'invalid-audit-secret' }) }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'accounts', client_secret: 'invalid-audit-secret' }) };
    check((await request(`/api/suite/${route}`, options)).status === 401, `${route.toUpperCase()}_STATUS`);
  }
  const signin = await request('/signin');
  check(signin.status === 200, 'SIGNIN_STATUS');
  const html = await signin.text();
  const assets = [...new Set([...html.matchAll(/(?:src|href)="([^" ]+)"/g)].map(match => match[1].split('?')[0]).filter(asset => asset.startsWith('/_next/static/') && /\.(?:js|css)$/.test(asset)))];
  check(assets.some(asset => asset.endsWith('.js')) && assets.some(asset => asset.endsWith('.css')), 'ASSETS_MISSING');
  for (const asset of assets) {
    const file = path.resolve(root, '.next', asset.slice('/_next/'.length));
    check(file.startsWith(path.resolve(root, '.next/static') + path.sep), 'ASSET_PATH');
    const response = await request(asset);
    check(response.status === 200, 'ASSET_STATUS');
    check(sha256(Buffer.from(await response.arrayBuffer())) === sha256(await readFile(file)), 'ASSET_MISMATCH');
  }
  return { sha: expected, assets: assets.length, suiteRoutes: 4, processVerified: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, expected, origin, pid] = process.argv.slice(2);
  verifyPreviousRelease({ root, expected, origin, pid }).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error('PREVIOUS_RELEASE_VERIFY_FAILED', /^[A-Z_]+$/.test(error.message) ? error.message : 'CHECK_FAILED');
    process.exitCode = 1;
  });
}
