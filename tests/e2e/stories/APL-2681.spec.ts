// SHO-US-23.5 Temporary password must be changed at first sign-in (APL-2624).
// New people are nakul17+ aliases and are deactivated afterwards.
// Fails setup if fixture credentials are absent. Mailbox reads use the APL-2681 sink.
// Ported from PR82; preserves all nine APL-2624 scenarios, including seven mailbox-dependent cases.
// AC6 (Forgot password) uses that sink and is not gated on the token.
import { test, expect, RUN, type Page } from "../support";
import { alias, BASE_URL, nextPass, PASS, signInAs, type Api } from "./qa";

import { waitForMail as waitForQaMail } from "../../mail-sink-client";

const WALL = "Set your own password";
const REPLACE = "The person must replace it with their own when they first sign in.";
const REFUSED = "Choose a new password. It cannot be the one we emailed you.";
const MAIN = "#main";

function screenSize(): { width: number; height: number } {
  return process.env.PW_VIEWPORT === "390x844" ? { width: 390, height: 844 } : { width: 1280, height: 720 };
}

async function addPerson(api: Api, tag: string, domain = "gmail.com") {
  const email = alias("2624", tag, domain);
  const created = await api.post("/api/team", { firstName: "ZZ-TEST", lastName: `person ${tag} ${RUN}`, email, role: "MEMBER" });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return { email, id: created.json.person.id as string };
}

async function mailedPassword(email: string, since?: string) {
  const text = (await waitForQaMail(email, "Your Sheet Happens Officer account", { baseUrl: BASE_URL, since })).text;
  const password = text.match(/^Password: (.+)$/m)?.[1];
  expect(password, "emailed temporary password").toBeTruthy();
  return password!;
}

async function openSignedIn(browser: Parameters<typeof signInAs>[0], email: string, password: string) {
  const who = await signInAs(browser, email, password);
  await who.page.setViewportSize(screenSize());
  return who;
}

async function expectAppOpen(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator(MAIN), url).toBeVisible();
  await expect(page.getByRole("heading", { name: WALL }), url).toHaveCount(0);
}

test.describe("SHO-US-23.5 / APL-2624", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(() => {
    if (!PASS || !process.env.MAIL_SINK_TOKEN) throw new Error("SHO-2681 mailbox acceptance requires SHO_QA_PASS and MAIL_SINK_TOKEN");
  });

  test.beforeEach(async ({ admin }) => {
    await admin.page.setViewportSize(screenSize());
  });

  // qa:TC missing
  test("AC1: after signing in with a Super-Admin-issued password, every screen but 'Set your own password' and sign-out is blocked", async ({ admin, browser, later }) => {
    const person = await addPerson(admin.api, "ac1");
    later(() => admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" }));
    const password = await mailedPassword(person.email);
    const who = await openSignedIn(browser, person.email, password);
    try {
      for (const url of ["/", "/projects", "/team", "/profile", "/search"]) {
        await who.page.goto(url);
        await expect(who.page.getByRole("heading", { name: WALL }), url).toBeVisible();
        await expect(who.page.locator("aside[aria-label='Main']"), url).toBeHidden();
        await expect(who.page.locator("nav[aria-label='Main']"), url).toBeHidden();
      }
      expect((await who.api.post("/api/auth/signout")).status).toBe(204);
    } finally {
      await who.ctx.close();
    }
  });

  // qa:TC missing
  test("AC2: a new password that meets the rules opens the asked-for page, clears the forced state, and the emailed password stops working", async ({ admin, browser, later }) => {
    const person = await addPerson(admin.api, "ac2");
    later(() => admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" }));
    const password = await mailedPassword(person.email);
    const who = await openSignedIn(browser, person.email, password);
    try {
      const next = nextPass(password);
      const changed = await who.api.post("/api/profile/password", { current: password, password: next, confirm: next });
      expect(changed.status, JSON.stringify(changed.json)).toBe(200);
      const oldTry = await who.ctx.request.post("/api/auth/signin", { data: { email: person.email, password } });
      expect(oldTry.ok(), "emailed password").toBe(false);
      const again = await openSignedIn(browser, person.email, next);
      try {
        await expectAppOpen(again.page, "/projects");
        const me = await again.api.get("/api/auth/me");
        expect(me.status).toBe(200);
        expect(me.json.user.mustChangePassword ?? false).toBe(false);
      } finally {
        await again.ctx.close();
      }
    } finally {
      await who.ctx.close();
    }
  });

  // qa:TC missing
  test("AC3: a new password equal to the emailed one is refused with 'Choose a new password. It cannot be the one we emailed you.'", async ({ admin, browser, later }) => {
    const person = await addPerson(admin.api, "ac3");
    later(() => admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" }));
    const password = await mailedPassword(person.email);
    const who = await openSignedIn(browser, person.email, password);
    try {
      const refused = await who.api.post("/api/profile/password", { current: password, password, confirm: password });
      expect(refused.status, JSON.stringify(refused.json)).toBe(400);
      expect(refused.json.error).toBe(REFUSED);
    } finally {
      await who.ctx.close();
    }
  });

  // qa:TC missing
  test("AC4: in the forced state every app API but change-password, sign-out and me answers 403 PASSWORD_CHANGE_REQUIRED", async ({ admin, browser, later }) => {
    const person = await addPerson(admin.api, "ac4");
    later(() => admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" }));
    const password = await mailedPassword(person.email);
    const who = await openSignedIn(browser, person.email, password);
    try {
      const me = await who.api.get("/api/auth/me");
      expect(me.status).toBe(200);
      const projects = await who.api.get("/api/projects");
      expect(projects.status).toBe(403);
      expect(JSON.stringify(projects.json)).toContain("PASSWORD_CHANGE_REQUIRED");
      const team = await who.api.get("/api/team");
      expect(team.status).toBe(403);
      expect(JSON.stringify(team.json)).toContain("PASSWORD_CHANGE_REQUIRED");
      const signedOut = await who.api.post("/api/auth/signout");
      expect(signedOut.status).toBe(204);
    } finally {
      await who.ctx.close();
    }
  });

  // qa:TC missing
  test("AC5: Resend sign-in details puts the person back in the forced state for the new password", async ({ admin, browser, later }) => {
    const person = await addPerson(admin.api, "ac5");
    later(() => admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" }));
    const first = await mailedPassword(person.email);
    const who = await openSignedIn(browser, person.email, first);
    try {
      const next = nextPass(first);
      expect((await who.api.post("/api/profile/password", { current: first, password: next, confirm: next })).status).toBe(200);
    } finally {
      await who.ctx.close();
    }
    const since = new Date().toISOString();
    const resent = await admin.api.post(`/api/team/${person.id}/resend`, {});
    expect(resent.status, JSON.stringify(resent.json)).toBe(200);
    const password = await mailedPassword(person.email, since);
    const back = await openSignedIn(browser, person.email, password);
    try {
      await back.page.goto("/");
      await expect(back.page.getByRole("heading", { name: WALL })).toBeVisible();
      const projects = await back.api.get("/api/projects");
      expect(projects.status).toBe(403);
      expect(JSON.stringify(projects.json)).toContain("PASSWORD_CHANGE_REQUIRED");
    } finally {
      await back.ctx.close();
    }
  });

  // qa:TC missing
  test("AC6 (own password): a person who set their own password is never forced", async ({ admin }) => {
    const me = await admin.api.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.json.user.mustChangePassword ?? false).toBe(false);
    for (const path of ["/api/projects", "/api/my-tasks", "/api/team"]) expect((await admin.api.get(path)).status, path).toBe(200);
    for (const url of ["/", "/projects", "/profile"]) await expectAppOpen(admin.page, url);
  });

  // qa:TC missing
  test("AC6 (Forgot password): a person who reset their password by email is never forced", async ({ admin, browser, later }) => {
    const person = await addPerson(admin.api, "ac6-forgot", "aplyd.com");
    later(() => admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" }));
    const since = new Date().toISOString();
    const asked = await admin.api.post("/api/auth/forgot-password", { email: person.email });
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    const mail = await waitForQaMail(person.email, "Reset your Sheet Happens Officer password", { baseUrl: BASE_URL, since });
    const token = mail.text.match(/token=([\w-]+)/)?.[1];
    expect(token, "reset link").toBeTruthy();
    const next = nextPass(PASS);
    const reset = await admin.api.post("/api/auth/reset-password", { token, password: next, confirm: next });
    expect(reset.status, JSON.stringify(reset.json)).toBe(200);
    const who = await openSignedIn(browser, person.email, next);
    try {
      for (const url of ["/", "/projects", "/profile"]) await expectAppOpen(who.page, url);
      const me = await who.api.get("/api/auth/me");
      expect(me.status).toBe(200);
      expect(me.json.user.mustChangePassword ?? false).toBe(false);
      expect((await who.api.get("/api/projects")).status).toBe(200);
    } finally {
      await who.ctx.close();
    }
  });

  // qa:TC missing
  test("AC7 (Add person): the dialog says the person must replace the password at first sign-in, not that it stays valid", async ({ admin }) => {
    await admin.page.goto("/team");
    const add = admin.page.getByRole("button", { name: /Add person/ });
    await expect(add).toBeVisible();
    await add.click();
    const dlg = admin.page.getByRole("dialog", { name: "Add person" });
    await expect(dlg).toContainText(REPLACE);
    await expect(dlg).not.toContainText(/stays valid/i);
    await dlg.getByRole("button", { name: "Cancel" }).click();
  });

  // qa:TC missing
  test("AC7 (email and banner): the email says the password is temporary and the closable banner is gone", async ({ admin, browser, later }) => {
    const person = await addPerson(admin.api, "ac7");
    later(() => admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" }));
    const text = (await waitForQaMail(person.email, "Your Sheet Happens Officer account", { baseUrl: BASE_URL })).text;
    expect(text.toLowerCase()).toContain("temporary");
    expect(text).not.toContain("stays valid");
    const password = text.match(/^Password: (.+)$/m)?.[1];
    expect(password).toBeTruthy();
    const who = await openSignedIn(browser, person.email, password!);
    try {
      await who.page.goto("/");
      await expect(who.page.getByText("The emailed one still works until you do.")).toHaveCount(0);
      await expect(who.page.getByRole("button", { name: "Close this message" })).toHaveCount(0);
    } finally {
      await who.ctx.close();
    }
  });
});
