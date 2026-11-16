import { expect, it, vi } from "vitest";
import { finishViewportFixture, type ViewportCleanupReceipt } from "./viewport/teardown";

const counts = { projects: 2, people: 2, organisation: true };

it("still cleans every owned fixture after browser close fails, and fails the suite", async () => {
  const cleanupProjectsAndPeople = vi.fn(async () => {});
  const archiveOrganisation = vi.fn(async () => {});
  let receipt: ViewportCleanupReceipt | undefined;
  await expect(finishViewportFixture(counts, {
    closeBrowser: async () => { throw new Error("synthetic browser failure"); },
    cleanupProjectsAndPeople,
    archiveOrganisation,
    record: (value) => { receipt = value; },
  })).rejects.toThrow("Viewport teardown failed: browser close failed");
  expect(cleanupProjectsAndPeople).toHaveBeenCalledOnce();
  expect(archiveOrganisation).toHaveBeenCalledOnce();
  expect(receipt).toMatchObject({ ...counts, projectsAndPeopleCleaned: true, organisationArchived: true, cleanup: true, failures: ["browser close failed"] });
  expect(JSON.stringify(receipt)).not.toContain("synthetic browser failure");
});

it("attempts organisation cleanup after project cleanup fails and records incomplete cleanup", async () => {
  const archiveOrganisation = vi.fn(async () => {});
  let receipt: ViewportCleanupReceipt | undefined;
  await expect(finishViewportFixture(counts, {
    closeBrowser: async () => {},
    cleanupProjectsAndPeople: async () => { throw new Error("synthetic cleanup failure"); },
    archiveOrganisation,
    record: (value) => { receipt = value; },
  })).rejects.toThrow("Viewport teardown failed: project/person cleanup failed");
  expect(archiveOrganisation).toHaveBeenCalledOnce();
  expect(receipt).toMatchObject({ projectsAndPeopleCleaned: false, organisationArchived: true, cleanup: false, failures: ["project/person cleanup failed"] });
  expect(JSON.stringify(receipt)).not.toContain("synthetic cleanup failure");
});
