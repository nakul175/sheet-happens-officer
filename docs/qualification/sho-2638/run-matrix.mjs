// Evidence-only runner. It never edits config files, shared staging or production.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, readdirSync, openSync, closeSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const repo = process.cwd(), sha = process.env.SHO_EXPECTED_SHA;
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), sha);
assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'src', 'prisma', 'package.json', 'package-lock.json', 'next.config.ts'], { cwd: repo, encoding: 'utf8' }).trim(), '');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1'].includes(database.hostname) && /^\/sho_test_[\w-]+$/.test(database.pathname), 'Use an isolated local sho_test_* database');
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) assert(!existsSync(path.join(repo, file)), 'Do not load an unreviewed environment file');
const password = process.env.SHO_QA_PASS;
assert(password && password.length >= 12, 'Provide a synthetic fixture password');
const require = createRequire(path.join(repo, 'package.json'));
const { chromium } = require('playwright-core');
const run = `${Date.now().toString(36)}-${process.pid}`;
const output = path.resolve(process.env.SHO_EVIDENCE_DIR ?? path.join(repo, 'test-results/sho-2638'));
const shotDir = path.join(output, 'screenshots'), privateDir = path.join(output, 'private', run);
mkdirSync(shotDir, { recursive: true }); mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const buildId = readFileSync(path.join(repo, '.next/BUILD_ID'), 'utf8').trim();
const superEmail = `zz-test-2638-${run}-super@aplyd.com`;
const tag = `ZZ-TEST 2638 ${run}`, dealName = `${tag} private opportunity`, dealTask = `${tag} private task`, plainTask = `${tag} ordinary task`;
const modes = new Map(), people = {}, projectIds = [], rows = [], browserRows = [];
let browser, dealId, dealTaskId, plainTaskId, organisationId, stageName, failure;
const ist = () => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'long' }).format(new Date());
const receipt = { story: 'SHO-2638', sourceSHA: sha, buildId, startedAt: new Date().toISOString(), startedAtIST: ist(), database: database.pathname.slice(1), modes: [], api: rows, browser: browserRows, conciergeCriterion: 'Retired by NJ; Concierge remains removed', configurationFilesChanged: false, productionChanged: false };
const day = n => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function call(s, method, url, who, body) {
  const response = await fetch(s.base + url, { method, headers: { 'content-type': 'application/json', ...(who ? { cookie: who.cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  return { status: response.status, json: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null, text, cookies: response.headers.getSetCookie() };
}
async function must(s, method, url, who, body, status = 200) {
  const r = await call(s, method, url, who, body); assert.equal(r.status, status, `${s.mode} ${method} ${url}: ${r.status} ${r.text}`); return r;
}
async function start(mode) {
  const port = await freePort(), base = `http://127.0.0.1:${port}`, outbox = path.join(privateDir, mode);
  mkdirSync(outbox, { mode: 0o700 }); const fd = openSync(path.join(outbox, 'server.log'), 'w', 0o600);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=1024', DATABASE_URL: process.env.DATABASE_URL, DIRECT_DATABASE_URL: process.env.DATABASE_URL, APP_URL: base, TASKBOARD_URL: base, EMAIL_OUTBOX_DIR: outbox, SUPER_ADMIN_EMAILS: superEmail, RELEASE: sha, SIGNIN_RETURN_TO: 'on', SEARCH_STAGE_A_ENABLED: 'false', CRM_VISIBLE: mode };
  const child = spawn(process.execPath, [path.join(repo, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: repo, env, detached: true, stdio: ['ignore', fd, fd] }); closeSync(fd);
  const s = { mode, base, outbox, child, port }; modes.set(mode, s);
  for (let i = 0; i < 100; i++) {
    assert(child.exitCode === null, `Mode ${mode} exited during startup`);
    try { const h = await call(s, 'GET', '/api/health'); if (h.status === 200) { assert.equal(h.json.release, sha); assert.equal(h.json.ok, true); receipt.modes.push({ mode, base, health: h.json, buildId }); return s; } } catch { /* bounded startup wait */ }
    await pause(200);
  }
  throw new Error(`Mode ${mode} did not become healthy`);
}
async function account(label, email) {
  const s = modes.get('all');
  await must(s, 'POST', '/api/auth/signup', null, { name: `ZZ-TEST 2638 ${label}`, email, password }, 201);
  let token;
  for (let i = 0; i < 30 && !token; i++) {
    for (const f of readdirSync(s.outbox).filter(f => f.endsWith('.json'))) { const m = JSON.parse(readFileSync(path.join(s.outbox, f), 'utf8')); if (m.to === email && /Verify/.test(m.subject)) token = m.text.match(/token=([\w-]+)/)?.[1]; }
    if (!token) await pause(100);
  }
  assert(token, 'Synthetic verification mail must be in the local outbox');
  await must(s, 'POST', '/api/auth/verify', null, { token });
  const r = await must(s, 'POST', '/api/auth/signin', null, { email, password });
  const cookie = r.cookies.find(c => c.startsWith('sho_session='))?.split(';')[0]; assert(cookie);
  return { id: r.json.user.id, cookie, label };
}
async function seed() {
  const s = modes.get('all'); people.Super = await account('Super', superEmail);
  for (const label of ['Leader', 'Editor', 'Admin']) people[label] = await account(label, `zz-test-2638-${run}-${label.toLowerCase()}@aplyd.com`);
  await must(s, 'PATCH', `/api/team/${people.Admin.id}`, people.Super, { orgRole: 'ADMIN' });
  const pipes = (await must(s, 'GET', '/api/deals/pipelines', people.Leader)).json.pipelines;
  const pipeline = pipes.find(p => p.key === 'DEAL_PROACTIVE'); assert(pipeline);
  const stage = pipeline.stages.find(s => s.name === 'Proposal') ?? pipeline.stages.find(s => s.category === 'ACTIVE'); assert(stage); stageName = stage.name;
  organisationId = (await must(s, 'POST', '/api/orgs', people.Leader, { name: `${tag} buyer` }, 201)).json.organisation.id;
  dealId = (await must(s, 'POST', '/api/deals', people.Leader, { name: dealName, organisationId, pipelineId: pipeline.id, leaderId: people.Leader.id, whyPursue: tag, nextStep: { title: `${tag} first step`, dueDate: day(3) } }, 201)).json.deal.id; projectIds.push(dealId);
  await must(s, 'POST', `/api/projects/${dealId}/stage`, people.Leader, { stageId: stage.id });
  const plainId = (await must(s, 'POST', '/api/projects', people.Leader, { name: `${tag} ordinary project`, leaderId: people.Leader.id }, 201)).json.project.id; projectIds.push(plainId);
  for (const id of projectIds) for (const who of [people.Editor, people.Admin, people.Super]) await must(s, 'POST', `/api/projects/${id}/members`, people.Leader, { userId: who.id, role: 'EDITOR' }, 201);
  for (const [id, title, assign] of [[dealId, dealTask, true], [plainId, plainTask, false]]) {
    const task = (await must(s, 'POST', `/api/projects/${id}/tasks`, people.Leader, { title, dueDate: day(2), assigneeId: people.Editor.id, collaboratorIds: [people.Admin.id, people.Super.id] }, 201)).json.task.id;
    if (assign) dealTaskId = task; else plainTaskId = task;
  }
  for (const who of Object.values(people)) await must(s, 'POST', '/api/profile/start-guide', who, {});
}
async function apiMatrix(s, role) {
  const who = people[role], visible = s.mode === 'all' || (s.mode === 'admins' && role !== 'Editor');
  const me = (await must(s, 'GET', '/api/auth/me', who)).json.user;
  assert.equal(me.orgRole, role === 'Super' ? 'SUPER_ADMIN' : role === 'Admin' ? 'ADMIN' : 'MEMBER');
  const my = await must(s, 'GET', '/api/my-tasks', who), byDeal = await must(s, 'GET', `/api/search?q=${encodeURIComponent(dealName)}`, who), byTask = await must(s, 'GET', `/api/search?q=${encodeURIComponent(dealTask)}`, who);
  const detail = await call(s, 'GET', `/api/tasks/${dealTaskId}`, who), tasks = await call(s, 'GET', `/api/projects/${dealId}/tasks`, who);
  const row = { mode: s.mode, role, expectedVisible: visible, dealTaskPresent: my.text.includes(dealTaskId), stagePresent: my.text.includes(stageName), ordinaryTaskPresent: my.text.includes(plainTaskId), dealSearchPresent: byDeal.text.includes(dealId), taskSearchPresent: byTask.text.includes(dealTaskId), taskStatus: detail.status, taskListStatus: tasks.status };
  rows.push(row);
  for (const key of ['dealTaskPresent', 'stagePresent', 'dealSearchPresent', 'taskSearchPresent']) assert.equal(row[key], visible, `${s.mode}/${role} ${key}`);
  assert(row.ordinaryTaskPresent, 'CRM hiding must preserve ordinary work'); assert.equal(detail.status, visible ? 200 : 404); assert.equal(tasks.status, visible ? 200 : 404);
  if (!visible) for (const r of [detail, tasks]) for (const value of [dealName, dealTask]) assert(!r.text.includes(value));
}
async function browserMatrix(s, role, width) {
  const who = people[role], visible = s.mode === 'all' || (s.mode === 'admins' && role !== 'Editor');
  const context = await browser.newContext({ viewport: { width, height: 900 }, baseURL: s.base });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const at = who.cookie.indexOf('='); await context.addCookies([{ name: who.cookie.slice(0, at), value: who.cookie.slice(at + 1), url: s.base }]);
  const page = await context.newPage(), errors = [], shots = []; page.on('pageerror', e => errors.push(e.message));
  const take = async step => { const file = `${s.mode}-${role.toLowerCase()}-${width}-${step}.png`; await page.screenshot({ path: path.join(shotDir, file), fullPage: true }); shots.push(file); };
  try {
    await page.goto('/my-tasks'); await page.getByRole('heading', { name: 'My tasks', exact: true }).waitFor(); await page.getByText(plainTask, { exact: true }).first().waitFor();
    if (visible) await page.getByText(dealTask, { exact: true }).first().waitFor(); else assert.equal(await page.getByText(dealTask, { exact: true }).count(), 0);
    assert.equal((await page.locator('a[href="/deals"]').count()) > 0, visible); await take('my-tasks');
    for (const [needle, id, step] of [[dealName, dealId, 'search-deal'], [dealTask, dealTaskId, 'search-task']]) {
      await page.goto('/search'); await page.getByRole('heading', { name: 'Search', exact: true }).waitFor();
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/search' && new URL(r.url()).searchParams.get('q') === needle && r.ok());
      await page.getByRole('searchbox', { name: 'Search', exact: true }).fill(needle); await response;
      const links = page.locator('main').locator(`a[href*="${id}"]`);
      if (visible) await links.first().waitFor(); else { await page.getByRole('status').filter({ hasText: /Nothing matches/ }).waitFor(); assert.equal(await links.count(), 0); }
      await take(step);
    }
    const response = await page.goto(`/tasks/${dealTaskId}`); assert.equal(response.status(), visible ? 200 : 404);
    if (visible) { const title = page.getByRole('textbox', { name: 'Title', exact: true }); await title.waitFor(); assert.equal(await title.inputValue(), dealTask); }
    else { await page.getByRole('heading', { name: "This task isn't available", exact: true }).waitFor(); const text = await page.locator('body').innerText(); assert(!text.includes(dealName) && !text.includes(dealTask)); }
    await take('direct-task'); assert.deepEqual(errors, []);
    browserRows.push({ mode: s.mode, role, width, expectedVisible: visible, passed: true, screenshots: shots });
  } catch (error) {
    try { await take('FAILED'); } catch { /* Keep the original failure if the page has already closed. */ }
    let headings;
    try {
      headings = await page.locator('h1').evaluateAll(elements => elements.map(el => ({ text: el.textContent, html: el.outerHTML, ancestors: [...(function* () { for (let p = el.parentElement; p; p = p.parentElement) yield p; })()].filter(p => p.hasAttribute('hidden') || p.hasAttribute('inert') || p.hasAttribute('aria-hidden')).map(p => ({ tag: p.tagName, hidden: p.getAttribute('hidden'), inert: p.getAttribute('inert'), ariaHidden: p.getAttribute('aria-hidden') })) })));
      writeFileSync(path.join(privateDir, `${s.mode}-${role}-${width}-failure.html`), await page.content());
    } catch { /* Screenshot and original error remain available. */ }
    browserRows.push({ mode: s.mode, role, width, expectedVisible: visible, passed: false, failure: error.message, url: page.url(), headings, screenshots: shots });
    throw error;
  } finally {
    await context.tracing.stop({ path: path.join(privateDir, `${s.mode}-${role}-${width}-trace.zip`) });
    await context.close();
  }
}
async function cleanup() {
  const s = modes.get('all'); if (!people.Super || !s) return;
  for (const id of projectIds) { await must(s, 'POST', `/api/projects/${id}/leader`, people.Leader, { newLeaderId: people.Super.id, previousRole: 'EDITOR' }); await must(s, 'POST', `/api/projects/${id}/archive`, people.Super, {}); }
  if (organisationId) await must(s, 'POST', `/api/orgs/${organisationId}/archive`, people.Super, { archive: true });
  for (const role of ['Leader', 'Editor', 'Admin']) if (people[role]) await must(s, 'POST', `/api/team/${people[role].id}/deactivate`, people.Super, { reassign: 'leaders' });
  await must(s, 'POST', '/api/auth/signout', people.Super, {}, 204); receipt.fixtureCleanup = true;
}
try {
  await Promise.all(['off', 'admins', 'all'].map(start)); await seed();
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || chromium.executablePath() });
  for (const mode of ['off', 'admins', 'all']) {
    const s = modes.get(mode);
    for (const role of ['Editor', 'Admin', 'Super']) await apiMatrix(s, role);
    await browserMatrix(s, 'Editor', 1280); await browserMatrix(s, 'Editor', 390);
    if (mode === 'admins') for (const role of ['Admin', 'Super']) await browserMatrix(s, role, 1280);
  }
  receipt.roleChecksPassed = true;
} catch (error) { failure = error; receipt.roleChecksPassed = false; receipt.failure = error.message; }
finally {
  await browser?.close();
  try { await cleanup(); } catch (error) { failure ??= error; receipt.fixtureCleanup = false; receipt.cleanupFailure = error.message; }
  for (const s of modes.values()) { try { process.kill(-s.child.pid, 'SIGTERM'); } catch { /* already stopped */ } }
  await pause(800);
  for (const s of modes.values()) {
    try { await call(s, 'GET', '/api/health'); try { process.kill(-s.child.pid, 'SIGKILL'); } catch { /* already stopped */ } } catch { /* expected closed port */ }
  }
  await pause(300);
  receipt.serversStopped = true;
  for (const s of modes.values()) { try { await call(s, 'GET', '/api/health'); receipt.serversStopped = false; } catch { /* expected */ } }
  receipt.completedAt = new Date().toISOString(); receipt.completedAtIST = ist();
  receipt.passed = !failure && receipt.fixtureCleanup === true && receipt.serversStopped;
  receipt.sourceProof = Object.fromEntries(['src/lib/crm.ts', 'src/lib/access.ts', 'src/lib/tasks.ts', 'src/lib/tasklist.ts', 'src/lib/search.ts'].map(f => [f, createHash('sha256').update(readFileSync(path.join(repo, f))).digest('hex')]));
  writeFileSync(path.join(output, 'matrix-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
if (failure) throw failure;
assert(receipt.serversStopped && receipt.fixtureCleanup);
console.log(JSON.stringify({ passed: true, apiRows: rows.length, browserRows: browserRows.length, screenshots: browserRows.flatMap(r => r.screenshots).length, sourceSHA: sha, buildId, serversStopped: true, fixtureCleanup: true }));
