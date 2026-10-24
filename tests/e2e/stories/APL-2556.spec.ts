// SHO-US-22.8 Concierge on phones (APL-2556). Epic SHO-E22.
// Runs against staging. Data: one ZZ-TEST project, archived afterwards. The concierge tests need the concierge switched ON on the
// server (a model key and MODEL_DATA_APPROVED); when it is off they skip, and AC4 (the off notice) runs instead.
// AC2/AC5 local-only proofs use real synthetic local changes. Browser viewport geometry is not a physical keyboard/device claim.
import { test, expect, zz, login, BASE_URL } from "../support";
import { newTask } from "../g2";
import { cleanChat } from "../helpers/jim-http";
import { ask, cardOf, requireModel, showConcierge, taskOf } from "../helpers/jim-concierge";
import { dueBeforeNextMonday } from "../helpers/proposal-fixture-date";
import type { Page } from "@playwright/test";
import type { Browser } from "@playwright/test";

async function phone(browser: Browser, width: number, height = 800, touch = true, who: "admin" | "member" = "admin") {
  const email = who === "admin" ? login("ADMIN").email : login("MEMBER").email;
  const password = who === "admin" ? login("ADMIN").password : login("MEMBER").password;
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    viewport: { width, height }, hasTouch: touch, isMobile: touch,
  });
  const r = await ctx.request.post("/api/auth/signin", { data: { email, password } });
  expect(r.ok(), `sign in as ${who}`).toBe(true);
  return ctx;
}

let projectId = "";
test.beforeEach(async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("22.8 concierge"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  projectId = r.json.project.id;
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
});

async function openConcierge(page: Page) {
  await page.goto("/", { waitUntil: "load" });
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Concierge" }).click();
  const sheet = page.getByRole("dialog", { name: "Concierge" });
  await expect(sheet).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const on = (await page.getByLabel("Message the concierge").count()) > 0;
  return { sheet, on };
}

test("AC1: the concierge fills the visible screen with the composer inside it (keyboard part needs a device)", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  const { sheet, on } = await openConcierge(page);
  test.skip(!on, "The concierge is not switched on on this server.");
  const b = (await sheet.boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(780 * 0.95);
  expect(b.width).toBeGreaterThanOrEqual(390 * 0.98);
  const c = (await sheet.getByLabel("Message the concierge", { exact: true }).boundingBox())!;
  expect(c.y + c.height).toBeLessThanOrEqual(780);
  await ctx.close();
});

test("AC2: the quick chips are at least 44 px high", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  const { on } = await openConcierge(page);
  test.skip(!on, "The concierge is not switched on on this server.");
  const chips = page.getByRole("group", { name: "Quick actions" }).getByRole("button");
  expect(await chips.count()).toBeGreaterThan(0);
  for (let i = 0; i < (await chips.count()); i++) expect((await chips.nth(i).boundingBox())!.height, `chip ${i}`).toBeGreaterThanOrEqual(44);
  await ctx.close();
});

test("AC2: the Confirm and Cancel buttons are at least 44 px high @local-only", async ({ browser, admin, later }, info) => {
  expect(["localhost","127.0.0.1"],"Synthetic local provider proof only").toContain(new URL(BASE_URL).hostname);
  await requireModel(admin);
  await showConcierge(admin,later);
  await cleanChat(admin,later);
  const title=zz("phone-card"),due=dueBeforeNextMonday();
  const id=await newTask(admin,projectId,{title,assigneeId:admin.user.id,dueDate:due});
  const ctx=await phone(browser,390,780);later(()=>ctx.close());
  const page=await ctx.newPage();
  const first=await ask(admin,`Move "${title}" to Monday.`);
  expect(first.status,JSON.stringify(first.json)).toBe(200);expect(cardOf(first.messages)?.canConfirm).toBe(true);
  await openConcierge(page);
  const sheet=page.getByRole("dialog",{name:"Concierge",exact:true});
  const pending=()=>sheet.locator(".cc-card").filter({has:page.getByRole("button",{name:"Confirm",exact:true})});
  const geometry=[];
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:780});
    for(const name of ["Confirm","Cancel"]) {
      const button=pending().getByRole("button",{name,exact:true});await expect(button).toBeEnabled();
      const r=(await button.boundingBox())!;expect(r.width).toBeGreaterThanOrEqual(44);expect(r.height).toBeGreaterThanOrEqual(44);expect(r.x).toBeGreaterThanOrEqual(0);expect(r.x+r.width).toBeLessThanOrEqual(width);geometry.push({viewportWidth:width,button:name,...r});
    }
  }
  await pending().getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(sheet.locator(".cc-card")).toContainText("Cancelled. Nothing was changed.");expect((await taskOf(admin,id)).dueDate).toBe(due);
  const second=await ask(admin,`Move "${title}" to Monday.`);expect(cardOf(second.messages)?.canConfirm).toBe(true);
  await openConcierge(page);
  await pending().getByRole("button",{name:"Confirm",exact:true}).click();
  await expect.poll(async()=>(await taskOf(admin,id)).dueDate).not.toBe(due);
  const result=sheet.locator(".cc-result").filter({has:page.getByRole("button",{name:"Undo",exact:true})});
  await expect(result.getByRole("button",{name:"Undo",exact:true})).toBeVisible();
  await result.getByRole("button",{name:"Undo",exact:true}).click();
  await expect.poll(async()=>(await taskOf(admin,id)).dueDate).toBe(due);
  await info.attach("local-phone-card-geometry",{body:JSON.stringify({scope:"Chromium viewport only; real provider card/Cancel/Confirm/inlineUndo",geometry}),contentType:"application/json"});
});

// The More menu item unmounts when the sheet opens; Close must restore focus to the persistent More entry.
test("AC3: Close closes the concierge and focus returns to the entry", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  const { sheet } = await openConcierge(page); // works with the concierge on or off: the sheet and its Close exist either way
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  const where = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName}.${a.className}|${a.textContent?.trim().slice(0, 12)}` : ""; });
  expect(where, "focus is on the More tab or the concierge button, not lost on <body>").toMatch(/More|Concierge|fab/i);
  await ctx.close();
});

test("AC3: Back closes the concierge", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  const { sheet } = await openConcierge(page);
  await page.goBack().catch(() => {});
  await expect(sheet).toHaveCount(0);
  await ctx.close();
});

test("AC4: when the concierge is switched off the notice shows and the rest of the app works", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  const { sheet, on } = await openConcierge(page);
  test.skip(on, "The concierge is switched on on this server, so there is no off notice to see.");
  await expect(sheet.locator(".cc-disabled")).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  await expect(page.getByRole("button", { name: "+ Add task" }).first()).toBeVisible({ timeout: 30000 });
  await ctx.close();
});

test("AC5: the undo toast does not overlap the entry or a bottom bar @local-only", async ({ browser, admin, later }, info) => {
  expect(["localhost","127.0.0.1"],"Owned local mutation proof only").toContain(new URL(BASE_URL).hostname);
  await showConcierge(admin,later);
  const id=await newTask(admin,projectId,{title:zz("phone-toast"),assigneeId:admin.user.id,dueDate:dueBeforeNextMonday()});
  const ctx=await phone(browser,390,780);later(()=>ctx.close());const page=await ctx.newPage();
  await page.goto(`/tasks/${id}`);
  const priority=page.getByRole("combobox",{name:"Priority",exact:true});await expect(priority).toHaveValue("MEDIUM");
  await priority.selectOption("HIGH");
  await expect.poll(async()=>(await taskOf(admin,id)).priority).toBe("HIGH");
  const toast=page.locator(".undo-toast").filter({has:page.getByRole("button",{name:"Undo",exact:true})});
  await expect(toast).toBeVisible();const geometry=[];
  for(const width of [390,320,390]) {
    await page.setViewportSize({width,height:780});await expect(toast).toBeVisible();
    const a=(await toast.boundingBox())!;expect(a.x).toBeGreaterThanOrEqual(0);expect(a.x+a.width).toBeLessThanOrEqual(width);expect(a.y+a.height).toBeLessThanOrEqual(780);
    const obstacles=page.locator(".cc-fabwrap .fab:visible, .tabbar-wrap:visible, .bardock:visible");
    expect(await obstacles.count(),"A real entry/bottom bar must be visible").toBeGreaterThan(0);
    for(let i=0;i<await obstacles.count();i++){const b=(await obstacles.nth(i).boundingBox())!;const overlap=Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x)&&Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y);expect(overlap,`toast overlaps entry/bar at ${width}`).toBe(false);geometry.push({width,toast:a,obstacle:b});}
  }
  await toast.getByRole("button",{name:"Undo",exact:true}).click({timeout:15000});await expect.poll(async()=>(await taskOf(admin,id)).priority).toBe("MEDIUM");
  await info.attach("local-real-task-undo-toast-geometry",{body:JSON.stringify({scope:"Ordinary actual task priority change global toast; distinct from Concierge inline Undo; Chromium viewport only",geometry}),contentType:"application/json"});
});
