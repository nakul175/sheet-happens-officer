// APL-2652. A signed-out deep link comes back after sign-in.
// Pam's cases are tagged qa:TC-APL2652-<id>@vN. Refs APL-2652.
// The file skips in beforeAll when SHO_QA_PASS is unset. It does not run in phone CI.
import type { APIResponse, Page } from "@playwright/test";
import { expect, login, test, zz, type Who } from "../support";
import { newProject, newTask } from "../g2";
import { gateFile, signInAlias, track } from "../helpers/qa-alias";
import { alias, nextPass, sinkText } from "./qa";

gateFile();

const WRONG = "wrong-pass-1";
const LOCKED = "Too many attempts. Try again in 15 minutes.";

function encodeTimes(value: string, times: number) {
  let out = value;
  for (let i = 0; i < times; i++) out = encodeURIComponent(out);
  return out;
}

function setCookie(res: APIResponse) {
  return res.headersArray().filter((row) => row.name.toLowerCase() === "set-cookie").map((row) => row.value).join("\n");
}

/** The running server sends people back only when SIGNIN_RETURN_TO is 1 or on. */
async function returnPathOn(page: Page) {
  const res = await page.request.get("/tasks/return-to-probe", { maxRedirects: 0 });
  const hay = `${res.headers().location ?? ""}\n${await res.text()}`;
  return /next=(?:%2F|\/)tasks(?:%2F|\/)return-to-probe/i.test(hay);
}

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function openTask(admin: Who, later: (fn: () => Promise<unknown>) => void, label: string) {
  const project = await newProject(admin, later, { label });
  const title = zz(label);
  const id = await newTask(admin, project.id, { title, description: zz(`${label} detail`) });
  return { project, id, title };
}

test("qa:TC-APL2652-ec2e2800@v2 a signed-out task link is still /tasks/<id> after sign-in", async ({ admin, anon, later }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const task = await openTask(admin, later, "ac1");
  const creds = login("ADMIN");
  await anon.goto(`/tasks/${task.id}`);
  await expect(anon.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(new URL(anon.url()).searchParams.get("next")).toBe(`/tasks/${task.id}`);
  await signIn(anon, creds.email, creds.password);
  await expect(anon.locator("textarea.tt")).toHaveValue(task.title);
  const url = new URL(anon.url());
  expect(url.pathname).toBe(`/tasks/${task.id}`);
  expect(url.search).toBe("");
  expect(url.hash).toBe("");
});

test("qa:TC-APL2652-a67fe308@v1 the query is kept and the fragment is dropped", async ({ admin, anon, later }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const task = await openTask(admin, later, "query");
  const creds = login("ADMIN");
  await anon.goto(`/tasks/${task.id}?tab=comments#c9`);
  await expect(anon.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const opened = new URL(anon.url());
  expect(opened.searchParams.get("next")).toBe(`/tasks/${task.id}?tab=comments`);
  expect(opened.hash).toBe("");
  await signIn(anon, creds.email, creds.password);
  await expect(anon.locator("textarea.tt")).toHaveValue(task.title);
  const url = new URL(anon.url());
  expect(url.pathname).toBe(`/tasks/${task.id}`);
  expect(url.search).toBe("?tab=comments");
  expect(url.hash).toBe("");
});

test("qa:TC-APL2652-36bc1ef6@v3 an absolute next is ignored", async ({ anon }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const creds = login("ADMIN");
  await anon.goto(`/signin?next=${encodeURIComponent("https://evil.example/tasks/1")}`);
  await signIn(anon, creds.email, creds.password);
  await expect(anon.getByRole("heading", { name: "My tasks" })).toBeVisible();
  expect(new URL(anon.url()).pathname).toBe("/");
  expect(anon.url()).not.toContain("evil.example");
});

test("qa:TC-APL2652-697b0b7d@v3 a protocol-relative or backslash next is ignored", async ({ anon }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const creds = login("ADMIN");
  for (const next of ["//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
    await anon.goto(`/signin?next=${encodeURIComponent(next)}`);
    await signIn(anon, creds.email, creds.password);
    await expect(anon.getByRole("heading", { name: "My tasks" })).toBeVisible();
    expect(new URL(anon.url()).pathname, next).toBe("/");
    expect(anon.url(), next).not.toContain("evil.example");
    await anon.context().request.post("/api/auth/signout");
    await anon.goto("/signin");
  }
});

test("qa:TC-APL2652-9a0b7cb9@v2 an /api or /signin next is ignored", async ({ anon }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const creds = login("ADMIN");
  for (const next of ["/api/tasks", "/signin?next=/tasks/1"]) {
    await anon.goto(`/signin?next=${encodeURIComponent(next)}`);
    await signIn(anon, creds.email, creds.password);
    await expect(anon.getByRole("heading", { name: "My tasks" })).toBeVisible();
    expect(new URL(anon.url()).pathname, next).toBe("/");
    await anon.context().request.post("/api/auth/signout");
    await anon.goto("/signin");
  }
});

test("qa:TC-APL2652-c26e8af9@v1 five decodes of a safe path work and encoded whitespace does not", async ({ admin, anon, later }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const task = await openTask(admin, later, "layers");
  const creds = login("ADMIN");
  const safe = `/tasks/${task.id}?tab=comments`;
  await anon.goto(`/signin?next=${encodeTimes(safe, 5)}`);
  await signIn(anon, creds.email, creds.password);
  await expect(anon.locator("textarea.tt")).toHaveValue(task.title);
  expect(new URL(anon.url()).pathname + new URL(anon.url()).search).toBe(safe);
  await anon.context().request.post("/api/auth/signout");
  await anon.goto(`/signin?next=${encodeURIComponent(`/tasks/${task.id}%20x`)}`);
  await signIn(anon, creds.email, creds.password);
  await expect(anon.getByRole("heading", { name: "My tasks" })).toBeVisible();
  expect(new URL(anon.url()).pathname).toBe("/");
  await anon.context().request.post("/api/auth/signout");
  await anon.goto(`/signin?next=${encodeTimes(safe, 6)}`);
  await signIn(anon, creds.email, creds.password);
  await expect(anon.getByRole("heading", { name: "My tasks" })).toBeVisible();
  expect(new URL(anon.url()).pathname).toBe("/");
});

test("qa:TC-APL2652-7526bdb0@v3 a hidden task and a missing task are the same 404 page", async ({ admin, browser, later }) => {
  const task = await openTask(admin, later, "hidden");
  const signed = await signInAlias(browser, alias("2652", "out"), zz("outsider"));
  track(later, signed.ctx);
  later(() => admin.api.post(`/api/team/${String(signed.who.user.id)}/deactivate`, { reassign: "leaders" }));
  const missing = task.id.slice(0, -1) + (task.id.endsWith("a") ? "b" : "a");
  const read = async (id: string) => {
    const res = await signed.who.page.request.get(`/tasks/${id}`, { maxRedirects: 0 });
    return { status: res.status(), html: await res.text() };
  };
  const hidden = await read(task.id);
  const gone = await read(missing);
  expect(hidden.status).toBe(404);
  expect(gone.status).toBe(404);
  const title = (html: string) => html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
  expect(title(hidden.html)).toBe("Task · Sheet Happens Officer");
  expect(title(gone.html)).toBe(title(hidden.html));
  expect(hidden.html).toContain("This task isn't available");
  expect(hidden.html).not.toContain(task.title);
  const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, "").split(task.id).join("ID").split(missing).join("ID");
  expect(visible(hidden.html)).toBe(visible(gone.html));
});

test("qa:TC-APL2652-5cb7edb7@v2 the hidden and missing task APIs are the same 404", async ({ admin, browser, later }) => {
  const task = await openTask(admin, later, "api404");
  const signed = await signInAlias(browser, alias("2652", "api"), zz("api outsider"));
  track(later, signed.ctx);
  later(() => admin.api.post(`/api/team/${String(signed.who.user.id)}/deactivate`, { reassign: "leaders" }));
  const missing = task.id.slice(0, -1) + (task.id.endsWith("a") ? "b" : "a");
  const denied = await signed.who.api.get(`/api/tasks/${task.id}`);
  const gone = await signed.who.api.get(`/api/tasks/${missing}`);
  expect(denied.status).toBe(404);
  expect(gone.status).toBe(404);
  expect(denied.json).toEqual({ error: "Task not found" });
  expect(gone.json).toEqual(denied.json);
  expect(JSON.stringify(denied.json)).not.toContain(task.title);
});

test("qa:TC-APL2652-744ac899@v3 a wrong password keeps the return target", async ({ admin, anon, later }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const task = await openTask(admin, later, "retry");
  const creds = login("ADMIN");
  await anon.goto(`/signin?next=${encodeURIComponent(`/tasks/${task.id}`)}`);
  await anon.getByLabel("Work email").fill(creds.email);
  await anon.getByLabel("Password").fill(WRONG);
  await anon.getByRole("button", { name: "Sign in" }).click();
  await expect(anon.getByRole("alert").filter({ hasText: "Email or password is incorrect." })).toBeVisible();
  expect(new URL(anon.url()).searchParams.get("next")).toBe(`/tasks/${task.id}`);
  await anon.getByLabel("Password").fill(creds.password);
  await anon.getByRole("button", { name: "Sign in" }).click();
  await expect(anon.locator("textarea.tt")).toHaveValue(task.title);
  expect(new URL(anon.url()).pathname).toBe(`/tasks/${task.id}`);
});

test("qa:TC-APL2652-41bcfb02@v2 five failures lock the account and the return target stays", async ({ admin, anon, later }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const email = alias("2652", "lock");
  const added = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: zz("lock"), email, role: "MEMBER" });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  const personId = String(added.json.person?.id ?? "");
  expect(personId).not.toBe("");
  later(() => admin.api.post(`/api/team/${personId}/deactivate`, { reassign: "leaders" }));
  const mailed = await sinkText(email, "Your Sheet Happens Officer account");
  const password = mailed?.match(/^Password: (\S+)$/m)?.[1] ?? "";
  test.skip(!password, "No temporary-password mail in the sink");
  await anon.goto(`/signin?next=${encodeURIComponent("/")}`);
  await anon.getByLabel("Work email").fill(email);
  for (let i = 0; i < 5; i++) {
    await anon.getByLabel("Password").fill(`${WRONG}-${i}`);
    await anon.getByRole("button", { name: "Sign in" }).click();
    await expect(anon.getByRole("alert")).toBeVisible();
  }
  await anon.getByLabel("Password").fill(password);
  await anon.getByRole("button", { name: "Sign in" }).click();
  await expect(anon.getByRole("alert").filter({ hasText: LOCKED })).toBeVisible();
  expect(new URL(anon.url()).searchParams.get("next")).toBe("/");
});

test("qa:TC-APL2652-544f8d39@v3 a temporary password is changed before the deep link opens", async ({ admin, anon, later }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const task = await openTask(admin, later, "wall");
  const email = alias("2652", "wall");
  const added = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: zz("wall"), email, role: "MEMBER" });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  const personId = String(added.json.person?.id ?? "");
  later(() => admin.api.post(`/api/team/${personId}/deactivate`, { reassign: "leaders" }));
  const joined = await admin.api.post(`/api/projects/${task.project.id}/members`, { userId: personId, role: "EDITOR" });
  expect(joined.status).toBe(201);
  const mailed = await sinkText(email, "Your Sheet Happens Officer account");
  const password = mailed?.match(/^Password: (\S+)$/m)?.[1] ?? "";
  test.skip(!password, "No temporary-password mail in the sink");
  await anon.goto(`/signin?next=${encodeURIComponent(`/tasks/${task.id}`)}`);
  await signIn(anon, email, password);
  await expect(anon.getByRole("heading", { name: "Set your own password" })).toBeVisible();
  expect(new URL(anon.url()).pathname).toBe(`/tasks/${task.id}`);
  await expect(anon.getByText(task.title)).toHaveCount(0);
  const wall = anon.locator("form").filter({ has: anon.getByRole("button", { name: "Save and continue" }) });
  const chosen = nextPass(password);
  await wall.locator('input[name="current"]').fill(password);
  await wall.locator('input[name="password"]').fill(chosen);
  await wall.locator('input[name="confirm"]').fill(chosen);
  await wall.getByRole("button", { name: "Save and continue" }).click();
  await expect(anon.locator("textarea.tt")).toHaveValue(task.title);
  expect(new URL(anon.url()).pathname).toBe(`/tasks/${task.id}`);
});

test("qa:TC-APL2652-f33f30c2@v2 a mid-use 401 returns to the task with expired=1", async ({ admin, anon, later }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const task = await openTask(admin, later, "expired");
  const creds = login("ADMIN");
  const signed = await anon.context().request.post("/api/auth/signin", { data: { email: creds.email, password: creds.password } });
  expect(signed.ok()).toBe(true);
  let tripped = false;
  await anon.route(`**/api/tasks/${task.id}`, async (route) => {
    if (!tripped) {
      tripped = true;
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Not signed in" }) });
      return;
    }
    await route.continue();
  });
  await anon.goto(`/tasks/${task.id}`);
  await expect(anon.getByRole("alert").filter({ hasText: "Your session has expired, please sign in again" })).toBeVisible();
  const url = new URL(anon.url());
  expect(url.pathname).toBe("/signin");
  expect(url.searchParams.get("expired")).toBe("1");
  expect(url.searchParams.get("next")).toBe(`/tasks/${task.id}`);
});

test("qa:TC-APL2652-c6291336@v2 a 401 on the sign-in screen does not navigate again", async ({ anon }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  await anon.goto("/signin?next=%2Ftasks%2FT1&expired=1");
  await anon.route("**/api/auth/me", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Not signed in" }) });
  });
  await anon.reload();
  await expect(anon.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const url = new URL(anon.url());
  expect(url.pathname).toBe("/signin");
  expect(url.searchParams.get("next")).toBe("/tasks/T1");
});

test("qa:TC-APL2652-2b1fae77@v2 expired=1 shows the session alert until another error", async ({ anon }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const creds = login("ADMIN");
  await anon.goto(`/signin?expired=1&next=${encodeURIComponent("/projects")}`);
  await expect(anon.getByRole("alert").filter({ hasText: "Your session has expired, please sign in again" })).toBeVisible();
  await anon.getByLabel("Work email").fill(creds.email);
  await anon.getByLabel("Password").fill(WRONG);
  await anon.getByRole("button", { name: "Sign in" }).click();
  await expect(anon.getByRole("alert").filter({ hasText: "Email or password is incorrect." })).toBeVisible();
  await expect(anon.getByText("Your session has expired, please sign in again")).toHaveCount(0);
  expect(new URL(anon.url()).searchParams.get("expired")).toBe("1");
  expect(new URL(anon.url()).searchParams.get("next")).toBe("/projects");
});

test("qa:TC-APL2652-9c54f732@v1 a fragment is not part of the 401 return path", async ({ admin, anon, later }) => {
  test.skip(!(await returnPathOn(anon)), "SIGNIN_RETURN_TO is off on this server");
  const task = await openTask(admin, later, "frag");
  await anon.goto(`/tasks/${task.id}?tab=comments#c9`);
  const url = new URL(anon.url());
  expect(url.pathname).toBe("/signin");
  expect(url.hash).toBe("");
  expect(url.searchParams.get("next")).toBe(`/tasks/${task.id}?tab=comments`);
  expect(url.searchParams.get("next")).not.toContain("#");
});

test("qa:TC-APL2652-0351fe22@v3 a signed-in project page is unchanged and sets no return cookie", async ({ admin }) => {
  const res = await admin.page.request.get("/projects", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(setCookie(res).toLowerCase()).not.toContain("sho_return_to");
  expect(await res.text()).not.toContain("NEXT_REDIRECT;replace;/signin");
});

test("qa:TC-APL2652-aae7f054@v2 with the flag off, next is ignored and sign-in lands at home", async ({ anon }) => {
  test.skip(await returnPathOn(anon), "This case is the flag-off server. The return path is on here.");
  const creds = login("ADMIN");
  await anon.goto(`/signin?next=${encodeURIComponent("/tasks/flag-off")}&expired=1`);
  await expect(anon.getByText("Your session has expired, please sign in again")).toHaveCount(0);
  await signIn(anon, creds.email, creds.password);
  await expect(anon.getByRole("heading", { name: "My tasks" })).toBeVisible();
  const url = new URL(anon.url());
  expect(url.pathname).toBe("/");
  expect(url.search).toBe("");
});

test("qa:TC-APL2652-702cc1f2@v1 only 1 or on enables the return path", async ({ anon }) => {
  const on = await returnPathOn(anon);
  test.skip(on, "The server is already on. Unset, empty, and any value other than 1 or on stay off; this case needs that server.");
  const creds = login("ADMIN");
  await anon.goto(`/signin?next=${encodeURIComponent("/tasks/not-enabled")}`);
  await signIn(anon, creds.email, creds.password);
  await expect(anon.getByRole("heading", { name: "My tasks" })).toBeVisible();
  expect(new URL(anon.url()).pathname).toBe("/");
});

test("qa:TC-APL2652-0f4e53e7@v1 no response sets a sho_return_to cookie", async ({ anon }) => {
  for (const path of ["/signin", "/signin?expired=1", "/tasks/return-to-probe"]) {
    const res = await anon.request.get(path, { maxRedirects: 0 });
    expect(setCookie(res).toLowerCase(), path).not.toContain("sho_return_to");
    await res.text();
  }
  await anon.goto("/signin");
  expect(await anon.evaluate(() => document.cookie)).not.toContain("sho_return_to");
});
