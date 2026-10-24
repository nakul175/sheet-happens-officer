import { expect, it } from "vitest";
import { taskSelectionForRequest } from "../src/lib/concierge/task-selection";
const groups = [{ kind: "task", ids: ["a", "b", "unseen", "a"] }];
const seen = new Set(["a", "b"]);
it("asks only about already-visible task matches and never includes unseen IDs", () => {
  expect(taskSelectionForRequest("Move the budget task", groups, seen, new Set())).toEqual({ kind: "task", ids: ["a", "b"] });
});
it.each(["Find budget tasks", "What are the budget tasks?", 'Show the task titled "Move budget"', "I moved the task"])("leaves a read or statement alone: %s", request => {
  expect(taskSelectionForRequest(request, groups, seen, new Set())).toBeUndefined();
});
it("does not ask again after the person selected a matching task", () => {
  expect(taskSelectionForRequest("Move budget", groups, seen, new Set(["a"]))).toBeUndefined();
});
it("does not turn one visible match or people-only results into a task choice", () => {
  expect(taskSelectionForRequest("Move budget", groups, new Set(["a"]), new Set())).toBeUndefined();
  expect(taskSelectionForRequest("Move budget", [{ kind: "person", ids: ["a", "b"] }], seen, new Set())).toBeUndefined();
});
