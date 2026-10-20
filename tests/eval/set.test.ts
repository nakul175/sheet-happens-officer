import { describe, expect, it } from "vitest";
import { assertFixture } from "./seed";
import { DUE } from "./clock";
import { PROMPTS } from "./prompts";
import { CATEGORIES, type Category } from "./types";

describe("concierge eval set", () => {
  it("has at least 50 prompts and at least 5 in every category", () => {
    expect(PROMPTS.length).toBeGreaterThanOrEqual(50);
    const counts = new Map<Category, number>(CATEGORIES.map((c) => [c, 0]));
    const ids = new Set<string>();
    for (const prompt of PROMPTS) {
      expect(CATEGORIES).toContain(prompt.category);
      counts.set(prompt.category, (counts.get(prompt.category) ?? 0) + 1);
      expect(ids.has(prompt.id), prompt.id).toBe(false);
      ids.add(prompt.id);
      expect(prompt.text.trim().length).toBeGreaterThan(0);
      assertFixture(prompt);
      const world = {
        actor: { id: "actor", name: "Nora Vale", orgRole: "MEMBER" as const },
        people: Object.fromEntries(prompt.fixture.people.map((p) => [p.key, { id: `user_${p.key}`, name: p.name, email: `${p.key}@eval.invalid` }])),
        projects: Object.fromEntries(prompt.fixture.projects.map((p) => [p.key, { id: `project_${p.key}`, name: p.name }])),
        tasks: Object.fromEntries((prompt.fixture.tasks ?? []).map((t) => [t.key, { id: `task_${t.key}`, title: t.title }])),
        notes: Object.fromEntries((prompt.fixture.notes ?? []).map((n) => [n.key, { id: `note_${n.key}`, text: n.text }])),
      };
      const exp = prompt.expect(world);
      expect(exp).toBeTruthy();
    }
    for (const category of CATEGORIES) expect(counts.get(category), category).toBeGreaterThanOrEqual(5);
  });

  it("resolves relative dates from Monday 17 March 2031", () => {
    expect(DUE.today).toBe("2031-03-17");
    expect(DUE.tomorrow).toBe("2031-03-18");
    expect(DUE.monday).toBe("2031-03-24");
    expect(DUE.nextWeek).toBe("2031-03-24");
    expect(DUE.endOfWeek).toBe("2031-03-21");
    expect(DUE.endOfMonth).toBe("2031-03-31");
    expect(DUE.in3Days).toBe("2031-03-20");
  });
});
