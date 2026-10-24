import { expect, it } from "vitest";
import { screenOnlyHelp } from "../src/lib/concierge/screen-help";
it.each(["Deactivate the editor", "Please deactivate the person with email synthetic@aplyd.com", "DEACTIVATE a user"])("returns only fixed screen guidance for %s", request => {
  expect(screenOnlyHelp(request)).toBe("Use the Team screen to deactivate a person if your role permits it. Nothing has changed.");
});
it.each(["Show the task titled Deactivate the person", "What happens if I deactivate the user?", "I have deactivated the person", '"Deactivate the person" is a task title', "Assign the task to a person", "Complete the task"])("never infers or performs any write for %s", request => {
  expect(screenOnlyHelp(request)).toBeNull();
});

it("a mixed imperative gets guidance only, never a claim that either action happened", () => {
  expect(screenOnlyHelp("Deactivate the editor and complete a task")).toBe("Use the Team screen to deactivate a person if your role permits it. Nothing has changed.");
});
