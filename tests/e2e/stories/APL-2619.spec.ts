// APL-2619 · [SHO-E23] People and access. One test per acceptance criterion.
// Pam qa:TC: none on the issue. Password comes from SHO_QA_PASS. Names use ZZ-TEST. Emails are nakul17+ aliases.
// SHO-US-23.5 (forced change at first sign-in) is not built and is not covered here.
import { test, login } from "../support";
import {
  PASS, passwordOk, alias, zz, RUN, gate, signUp, signInAs, personByEmail, deactivate,
  latestMail, mailedPassword, mailToken, expect,
} from "./qa";

const DOMAIN = "Use your @aplyd.com or @athenainfonomics.com email address.";

test.beforeAll(async ({ request }) => {
  if (!PASS) throw new Error("Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  login("ADMIN");
  await gate(request);
});

test("AC1: self-signup allows @aplyd.com and @athenainfonomics.com, and refuses any other domain", async ({ anon, admin, later }) => {
  for (const [tag, domain] of [["aplyd", "aplyd.com"], ["athena", "athenainfonomics.com"]] as const) {
    const email = alias("2619", tag, domain);
    const signed = await signUp(anon.request, zz(tag), email);
    expect(signed.status, signed.body).toBe(201);
    expect(signed.json.status).toBe("check_email");
    expect(mailToken(email, "Verify"), email).toBeTruthy();
    const person = await personByEmail(admin.api, email);
    expect(person?.status).toBe("UNVERIFIED");
    later(() => deactivate(admin.api, person!.id));
  }
  const refused = await signUp(anon.request, zz("gmail"), alias("2619", "nope"));
  expect(refused.status).toBe(400);
  expect(refused.body).toContain(DOMAIN);
  expect(await personByEmail(admin.api, alias("2619", "nope"))).toBeNull();
});

test("AC2: the Super Admin adds a person on any domain, active, with no verification link", async ({ admin, later }) => {
  const email = alias("2619", "ac2");
  const body = { firstName: "ZZ-TEST", lastName: `ac2 ${RUN}`, email, role: "MEMBER" as const };
  const created = await admin.api.post("/api/team", body);
  const text = JSON.stringify(created.json);
  const pass = PASS;
  expect(text.includes(pass)).toBe(false);
  expect(created.status, text).toBe(201);
  expect(created.json.person.email).toBe(email);
  later(() => deactivate(admin.api, created.json.person.id as string));
  const person = await personByEmail(admin.api, email);
  expect(person?.status).toBe("ACTIVE");
  expect(mailToken(email, "Verify"), "an added person does not get a verification link").toBeNull();
});

test("AC3: a person added by the Super Admin receives an email with their sign-in details", async ({ admin, later }) => {
  const email = alias("2619", "ac3");
  const created = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `ac3 ${RUN}`, email, role: "MEMBER" });
  const text = JSON.stringify(created.json);
  expect(created.status, text).toBe(201);
  expect(created.json.person.emailSent).toBe(true);
  later(() => deactivate(admin.api, created.json.person.id as string));
  const mail = latestMail(email, "Your Sheet Happens Officer account");
  expect(mail, "sign-in email in the local outbox").toBeTruthy();
  expect(mail!).toContain(`Username: ${email}`);
  expect(mail!).toContain("Password: ");
  const pass = mail!.match(/^Password: (.+)$/m)![1];
  expect(text.includes(pass)).toBe(false);
});

test("AC4: signing in with the emailed password shows a banner to set their own", async ({ admin, browser, later }) => {
  const email = alias("2619", "ac4");
  const created = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `ac4 ${RUN}`, email, role: "MEMBER" });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  later(() => deactivate(admin.api, created.json.person.id as string));
  const pass = mailedPassword(email);
  expect(pass, "emailed password").toBeTruthy();
  const who = await signInAs(browser, email, pass!);
  later(() => who.ctx.close());
  await who.page.goto("/");
  await expect(who.page.getByText("Set your own password. The emailed one still works until you do.")).toBeVisible();
  await expect(who.page.getByRole("link", { name: "Change password" })).toHaveAttribute("href", "/profile");
});

test("AC5: clicking a person's name on the Team page opens their full profile", async ({ admin, later }) => {
  const email = alias("2619", "ac5");
  const created = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `ac5 ${RUN}`, email, role: "MEMBER" });
  expect(created.status).toBe(201);
  const id = created.json.person.id as string;
  const name = created.json.person.name as string;
  later(() => deactivate(admin.api, id));

  await admin.page.goto("/team");
  await admin.page.locator("tr", { hasText: email }).getByRole("link", { name }).click();
  await expect(admin.page).toHaveURL(new RegExp(`/team/${id}$`));
  await expect(admin.page.getByRole("heading", { name })).toBeVisible();
  await expect(admin.page.getByText(`${email} · Member`)).toBeVisible();
  const profile = await admin.api.get(`/api/team/${id}`);
  expect(profile.status).toBe(200);
  expect(profile.json.person).toMatchObject({ id, name, email, orgRole: "MEMBER", status: "ACTIVE" });
  expect(Array.isArray(profile.json.person.projects)).toBe(true);
});

test("AC6: an added person's name is stored as one First Last field", async ({ admin, later }) => {
  const email = alias("2619", "ac6");
  const created = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `ac6 ${RUN}`, email, role: "MEMBER" });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.person.id as string;
  later(() => deactivate(admin.api, id));
  const person = (await admin.api.get(`/api/team/${id}`)).json.person as Record<string, unknown>;
  expect(person.name).toBe(`ZZ-TEST ac6 ${RUN}`);
  expect(person).not.toHaveProperty("firstName");
  expect(person).not.toHaveProperty("lastName");
});
