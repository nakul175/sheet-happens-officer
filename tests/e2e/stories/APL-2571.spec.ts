import { archiveProject } from "../helpers/migration-2731";
import { test } from "./qa";
// SHO-US-14.12 Density and visual hierarchy (APL-2571).
import { expect, zz, type Who, type Later } from "../support";

test.use({ viewport: { width: 1440, height: 900 } });

async function listProject(admin: Who, later: Later, n: number) {
  const r = await admin.api.post("/api/projects", { name: zz("density"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => archiveProject(admin.api, id, admin.user.id));
  for (let i = 0; i < n; i++) {
    const t = await admin.api.post(`/api/projects/${id}/tasks`, { title: `${zz("row")} ${String(i).padStart(2, "0")}`, assigneeId: admin.user.id, priority: "HIGH", dueDate: "2030-01-0" + ((i % 9) + 1) });
    expect(t.status).toBe(201);
  }
  return id;
}

test("AC1: Compact shows at least 16 rows at 1440 by 900 and the setting persists per person", async ({ admin, later }) => {
  const prior = await admin.api.get("/api/profile/density");
  expect(prior.status).toBe(200);
  const { compact } = prior.json as { compact: boolean };
  later(() => admin.api.put("/api/profile/density", { compact })); // put the shared Admin back
  await admin.api.put("/api/profile/density", { compact: false });
  const id = await listProject(admin, later, 20);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  const visibleRows = () => p.evaluate(() => [...document.querySelectorAll("main.content .item")].filter((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight; }).length);
  await expect(p.getByText(`${zz("row")} 00`).first()).toBeVisible();
  const comfortable = await visibleRows();
  await p.getByRole("button", { name: /Compact/ }).click();
  await expect(p.getByRole("button", { name: /Compact/ })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(visibleRows).toBeGreaterThanOrEqual(16);
  expect(await visibleRows()).toBeGreaterThan(comfortable);
  await expect.poll(async () => (await admin.api.get("/api/profile/density")).json).toEqual({ compact: true }); // saved on the person
  await p.reload();
  await expect(p.getByRole("button", { name: /Compact/ })).toHaveAttribute("aria-pressed", "true");
});

test("AC2: metadata is not link-coloured; only the title is interactive", async ({ admin, later }) => {
  const id = await listProject(admin, later, 3);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  const row = p.locator("main.content .item").filter({ hasText: `${zz("row")} 00` }).first();
  await expect(row).toBeVisible();
  const info = await row.evaluate((el) => {
    const meta = el.querySelector(".meta");
    const anchors = meta ? [...meta.querySelectorAll("a")].length : 0;
    const link = document.querySelector("main.content a, nav a");
    const linkColor = link ? getComputedStyle(link).color : "";
    const metaColors = meta ? [...meta.querySelectorAll("*")].map((n) => getComputedStyle(n).color) : [];
    return { anchors, linkColor, metaColors, hasMeta: !!meta };
  });
  expect(info.hasMeta).toBe(true);
  expect(info.anchors).toBe(0); // priority and assignee are not links
  const linkColor = info.linkColor;
  // none of the metadata uses the colour the app gives to links
  if (linkColor) expect(info.metaColors.some((c) => c === linkColor)).toBe(false);
});

test("AC3: hiding the concierge dock frees the width and the concierge stays reachable from a labelled button", async ({ admin, later }) => {
  const id = await listProject(admin, later, 3);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  const dock = p.locator("aside.cc-slot");
  const width = () => p.locator("main.content").first().evaluate((el) => el.getBoundingClientRect().width);
  await expect(dock).toBeVisible();
  const before = await width();
  await dock.getByRole("button", { name: "Hide" }).click();
  await expect(dock).toHaveCount(0);
  expect(await width()).toBeGreaterThan(before);
  const btn = p.getByRole("button", { name: /^Concierge/ }).first();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(p.locator("aside.cc-slot")).toBeVisible();
});

/** WCAG contrast of the visible text and SVG icons inside one row. Large text (24 px, or 18.66 px and bold) and icons need 3:1; other text needs 4.5:1. */
function rowContrast(root: HTMLElement | SVGElement): string[] {
  const parse = (c: string): [number, number, number, number] | null => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(c);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4]) / 100 : Number(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  };
  const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = (rgb: [number, number, number]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const over = (fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] => [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]),
  ];
  const bgOf = (el: Element): [number, number, number] => {
    const chain: Element[] = [];
    let n: Element | null = el;
    while (n) { chain.push(n); n = n.parentElement; }
    let bg: [number, number, number] = [255, 255, 255];
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = parse(getComputedStyle(chain[i]).backgroundColor);
      if (c && c[3] > 0) bg = over(c, bg);
    }
    return bg;
  };
  const ratio = (fg: [number, number, number], bg: [number, number, number]) => {
    const a = lum(fg), b = lum(bg);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (rgb: [number, number, number]) => "#" + rgb.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
  const fails: string[] = [];
  let texts = 0, icons = 0;
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
    const icon = el instanceof SVGElement;
    if (!own && !icon) continue;
    const fg = parse(cs.color);
    const bg = bgOf(el);
    if (!fg) { fails.push(`${own || "icon"} color ${cs.color} was not rgb`); continue; }
    const solid = over(fg, bg);
    const r = ratio(solid, bg);
    if (own) {
      texts++;
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66);
      const need = large ? 3 : 4.5;
      if (r + 1e-3 < need) fails.push(`text "${own.slice(0, 40)}" ${r.toFixed(2)} < ${need} (${hex(solid)} on ${hex(bg)})`);
    }
    if (icon) {
      icons++;
      if (r + 1e-3 < 3) fails.push(`icon ${r.toFixed(2)} < 3 (${hex(solid)} on ${hex(bg)})`);
    }
  }
  if (!texts) fails.push("no visible text on the row");
  if (!icons) fails.push("no visible icon on the row");
  return fails;
}

test("AC4: contrast of every text and icon is at least 4.5:1 (3:1 for large text and icons)", async ({ admin, later }) => {
  const prior = await admin.api.get("/api/profile/density");
  expect(prior.status).toBe(200);
  const { compact } = prior.json as { compact: boolean };
  later(() => admin.api.put("/api/profile/density", { compact }));
  await admin.api.put("/api/profile/density", { compact: false });
  const id = await listProject(admin, later, 3);
  const title = `${zz("row")} 00`;
  const sections = (await admin.api.get(`/api/projects/${id}/tasks`)).json.sections as { tasks: { id: string; title: string; updatedAt: string }[] }[];
  const task = sections.flatMap((s) => s.tasks).find((t) => t.title === title);
  expect(task, "the seeded row").toBeTruthy();
  const blocked = await admin.api.patch(`/api/tasks/${task!.id}`, { blocked: true, blockedReason: "ZZ-TEST contrast", expectedUpdatedAt: task!.updatedAt });
  expect(blocked.status, JSON.stringify(blocked.json)).toBe(200);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  const row = p.locator("main.content .item").filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText("Blocked")).toBeVisible();
  expect(await row.evaluate(rowContrast)).toEqual([]);
});
