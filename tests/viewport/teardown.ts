export type ViewportCleanupReceipt = {
  projects: number;
  people: number;
  organisation: boolean;
  projectsAndPeopleCleaned: boolean;
  organisationArchived: boolean;
  cleanup: boolean;
  failures: string[];
};

export async function finishViewportFixture(
  counts: Pick<ViewportCleanupReceipt, "projects" | "people" | "organisation">,
  actions: {
    closeBrowser: () => Promise<void>;
    cleanupProjectsAndPeople: () => Promise<void>;
    archiveOrganisation: () => Promise<void>;
    record: (receipt: ViewportCleanupReceipt) => void;
  },
) {
  const failures: string[] = [];
  let projectsAndPeopleCleaned = false;
  let organisationArchived = false;
  try { await actions.closeBrowser(); }
  catch { failures.push("browser close failed"); }
  try { await actions.cleanupProjectsAndPeople(); projectsAndPeopleCleaned = true; }
  catch { failures.push("project/person cleanup failed"); }
  try { await actions.archiveOrganisation(); organisationArchived = true; }
  catch { failures.push("organisation archive failed"); }
  const receipt = { ...counts, projectsAndPeopleCleaned, organisationArchived,
    cleanup: projectsAndPeopleCleaned && organisationArchived, failures };
  try { actions.record(receipt); }
  catch { failures.push("cleanup receipt write failed"); }
  if (failures.length) throw new Error(`Viewport teardown failed: ${failures.join("; ")}`);
  return receipt;
}
