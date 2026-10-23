// SHO-3028 (#156 S4). One place that builds the "hidden project" fixture the CRM_VISIBLE tests need:
// a deal (the project the lever can hide) and a plain project led by the same people, so a test can
// prove the hidden one is isolated while the visible one is not.
// Everything is created through the API as ZZ-TEST data; nothing is written to the database directly.
import { expect } from "vitest";
import { cleanupZz, istDate, superAdmin, type Account } from "./helpers";

export type CrmMode = "all" | "admins" | "off" | "on"; // "on" is the legacy spelling of all (crmMode treats it as all)

/**
 * Runs `fn` with CRM_VISIBLE set, then puts the previous value back. crmMode() reads the variable at
 * call time, so a test process can flip the lever without restarting the server.
 */
export async function withCrmMode<T>(mode: CrmMode, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CRM_VISIBLE;
  process.env.CRM_VISIBLE = mode;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CRM_VISIBLE;
    else process.env.CRM_VISIBLE = prev;
  }
}

export type FixtureProject = { id: string; name: string };

/** One deal a CRM_VISIBLE conceals, with the organisation and pipeline it was filed under. */
export type HiddenDealFixture = {
  deal: FixtureProject;
  organisationId: string;
  pipelineId: string;
  /** The deal's stage, when the deal API reports one. */
  stageName: string;
  /** The projects this fixture made, for cleanup. */
  projectIds: string[];
};

export type HiddenProjectFixture = HiddenDealFixture & {
  /** The control: an ordinary project the same caller still sees. */
  plain: FixtureProject;
};

/**
 * A person on the fixture's projects: a bare Account joins as Editor, or name the role when the test
 * needs the other one — a VIEWER is how the suite proves a read-only member is hidden too.
 */
export type HiddenMember = Account | { who: Account; role: "EDITOR" | "VIEWER" };

function asMember(m: HiddenMember): { who: Account; role: "EDITOR" | "VIEWER" } {
  return "who" in m ? m : { who: m, role: "EDITOR" };
}

export type HiddenDealOptions = {
  /** The person who leads the deal. */
  leader: Account;
  /** Included in the ZZ-TEST names, so one run's rows are told from another's. */
  label: string;
  /** People added to the deal. A test's viewer or leaver goes here; a bare Account is an Editor. */
  members?: HiddenMember[];
  /** Reuse an organisation another fixture made, so one cleanup archives it once. */
  organisationId?: string;
  /** Reuse a pipeline another fixture looked up. */
  pipelineId?: string;
  /** The hidden deal's first step. Defaults to "ZZ-TEST <label> step". */
  nextStepTitle?: string;
};

export type HiddenProjectOptions = HiddenDealOptions & {
  /** Leads the plain project only. Defaults to `leader`, which makes both projects that person's. */
  plainLeader?: Account;
  /**
   * People added to the plain control. Defaults to `members`, which is right when the control is the
   * same people's second project; pass `[]` when the control must be one they are not in.
   */
  plainMembers?: HiddenMember[];
};

/** The organisation and pipeline a deal needs, reused from the options when a sibling fixture made them. */
async function dealHome(sa: Account, o: HiddenDealOptions) {
  let pipelineId = o.pipelineId;
  if (!pipelineId) {
    const pipes = await sa.c.get("/api/deals/pipelines");
    expect(pipes.status, JSON.stringify(pipes.json)).toBe(200);
    const pipe = (pipes.json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
    expect(pipe?.id, "the deal pipeline DEAL_PROACTIVE must exist").toBeTruthy();
    pipelineId = pipe!.id;
  }
  let organisationId = o.organisationId;
  if (!organisationId) {
    const org = await sa.c.post("/api/orgs", { name: `ZZ-TEST Buyer ${o.label}` });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    organisationId = org.json.organisation.id as string;
  }
  return { organisationId, pipelineId };
}

/**
 * Creates one hidden deal through the API. A test that needs several deals for one Leader calls
 * this per deal and passes the first result's organisationId/pipelineId to the rest.
 */
export async function hiddenDeal(sa: Account, o: HiddenDealOptions): Promise<HiddenDealFixture> {
  const { organisationId, pipelineId } = await dealHome(sa, o);
  const name = `ZZ-TEST ${o.label} deal`;
  const made = await sa.c.post("/api/deals", {
    name,
    organisationId,
    pipelineId,
    leaderId: o.leader.id,
    whyPursue: "ZZ-TEST fit",
    nextStep: { title: o.nextStepTitle ?? `ZZ-TEST ${o.label} step`, dueDate: istDate(3) },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const deal: FixtureProject = { id: made.json.deal.id as string, name };
  const stage = made.json.deal.stage?.name ?? made.json.deal.stageName;
  const stageName = typeof stage === "string" ? stage : "";
  for (const { who, role } of (o.members ?? []).map(asMember)) {
    const added = await sa.c.post(`/api/projects/${deal.id}/members`, { userId: who.id, role });
    expect(added.status, `add ${who.email} to ${deal.name}: ${added.status} ${JSON.stringify(added.json)}`).toBe(201);
  }
  return { deal, organisationId, pipelineId, stageName, projectIds: [deal.id] };
}

/**
 * Creates a hidden-project fixture through the API: one deal and one plain project, optionally
 * sharing a Leader and some Editors. The plain project is the control that must stay visible.
 * The caller's afterAll passes the fixtures to cleanupHiddenProject.
 */
export async function hiddenProjectFixture(sa: Account, o: HiddenProjectOptions): Promise<HiddenProjectFixture> {
  const hidden = await hiddenDeal(sa, o);
  const plainLeader = o.plainLeader ?? o.leader;
  const name = `ZZ-TEST ${o.label} project`;
  const made = await sa.c.post("/api/projects", { name, leaderId: plainLeader.id });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const plain: FixtureProject = { id: made.json.project.id as string, name };
  for (const { who, role } of (o.plainMembers ?? o.members ?? []).map(asMember)) {
    const added = await sa.c.post(`/api/projects/${plain.id}/members`, { userId: who.id, role });
    expect(added.status, `add ${who.email} to ${plain.name}: ${added.status} ${JSON.stringify(added.json)}`).toBe(201);
  }
  return { ...hidden, plain, projectIds: [hidden.deal.id, plain.id] };
}

/**
 * Archives what the fixtures made through the API: every project (and person, when given) via
 * cleanupZz, then each distinct organisation once. Fails the calling test if the API refuses a step.
 * Accepts one fixture or a list, so two fixtures that share an organisation archive it once.
 */
export async function cleanupHiddenProject(
  fixture: HiddenDealFixture | HiddenDealFixture[],
  people: Account[] = [],
): Promise<void> {
  const fixtures = Array.isArray(fixture) ? fixture : [fixture];
  const projectIds = [...new Set(fixtures.flatMap((f) => f.projectIds))];
  await cleanupZz(projectIds, people);
  const sa = await superAdmin();
  for (const organisationId of new Set(fixtures.map((f) => f.organisationId))) {
    const archived = await sa.c.post(`/api/orgs/${organisationId}/archive`, { archive: true });
    expect(archived.status, `archive organisation ${organisationId}: ${archived.status} ${JSON.stringify(archived.json)}`).toBe(200);
  }
}
