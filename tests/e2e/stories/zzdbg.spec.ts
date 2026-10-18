import { test, zz } from "../support";
test("dbg", async ({ browser, admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("dbg"), leaderId: admin.user.id });
  const id = r.json.project.id; later(() => admin.api.post(`/api/projects/${id}/archive`));
  const secs = (await admin.api.get(`/api/projects/${id}`)).json.project.sections;
  const t = (await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("card"), sectionId: secs[0].id })).json.task.id;
  const ctx = await browser.newContext({ baseURL: process.env.STAGING_URL, viewport: { width: 1280, height: 900 } });
  await ctx.request.post("/api/auth/signin", { data: { email: process.env.SHO_ADMIN_EMAIL, password: process.env.SHO_ADMIN_PASS } });
  const p = await ctx.newPage(); await p.goto(`/projects/${id}?view=board`); await p.locator(".bcard").first().waitFor();
  await p.evaluate(() => {
    const card = document.querySelector(".bcard")!, col = document.querySelectorAll(".col")[1];
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await p.waitForTimeout(1500);
  console.log("SEC", (await admin.api.get(`/api/tasks/${t}`)).json.task.section.id === secs[1].id);
  // real mouse, element-level
  const t2 = (await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("card2"), sectionId: secs[0].id })).json.task.id;
  await p.reload(); await p.locator(".bcard", { hasText: "card2" }).waitFor();
  const a = (await p.locator(".bcard", { hasText: "card2" }).boundingBox())!, b = (await p.locator(".col").nth(1).boundingBox())!;
  await p.mouse.move(a.x + 50, a.y + 30); await p.mouse.down(); await p.mouse.move(a.x + 80, a.y + 40, { steps: 5 }); await p.mouse.move(b.x + 100, b.y + 30, { steps: 15 }); await p.waitForTimeout(300); await p.mouse.up();
  await p.waitForTimeout(1500);
  console.log("SEC2", (await admin.api.get(`/api/tasks/${t2}`)).json.task.section.id === secs[1].id);
});
