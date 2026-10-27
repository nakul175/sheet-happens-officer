// SHO-US-22.11: the screens and widths the phone checks cover. Add a screen here when you add a page.
export const WIDTHS = [320, 360, 390, 414, 599, 768] as const;
export const PHONE_MAX = 600; // under this width the 44 px and 16 px rules apply

export type Ids = { project: string; task: string; deal: string; org: string; person: string };
export type Screen = { name: string; path: (ids: Ids) => string; as?: "root" | "viewer"; public?: boolean; wait?: string };

export const SCREENS: Screen[] = [
  { name: "Sign in", path: () => "/signin", public: true },
  { name: "Sign up", path: () => "/signup", public: true },
  { name: "Forgot password", path: () => "/forgot", public: true },
  { name: "Check email", path: () => "/check-email", public: true },
  { name: "Check reset", path: () => "/check-reset", public: true },
  { name: "Reset password form", path: () => "/reset", public: true, wait: 'input[name="confirm"]' },
  // The query is deliberately inert: entering the page never submits verification.
  // A missing token redirects to Expired, which is covered separately below.
  { name: "Verification entry", path: () => "/verify?token=viewport-layout-only", public: true, wait: "text=Verify your email" },
  { name: "Expired link", path: () => "/expired", public: true },
  { name: "Offline", path: () => "/offline", public: true },
  { name: "Home dashboard", path: () => "/" },
  { name: "My tasks", path: () => "/my-tasks" },
  { name: "My tasks with task panel", path: (i) => `/my-tasks?task=${i.task}`, wait: 'textarea[aria-label="Title"]' },
  { name: "Projects", path: () => "/projects" },
  { name: "New project", path: () => "/projects/new" },
  { name: "Project list", path: (i) => `/projects/${i.project}` },
  { name: "Project board", path: (i) => `/projects/${i.project}?view=board` },
  { name: "Project board as Viewer", path: (i) => `/projects/${i.project}?view=board`, as: "viewer" },
  { name: "Project task panel", path: (i) => `/projects/${i.project}?task=${i.task}`, wait: 'textarea[aria-label="Title"]' },
  { name: "Project members", path: (i) => `/projects/${i.project}/members` },
  { name: "Project trash", path: (i) => `/projects/${i.project}/trash` },
  { name: "Project activity", path: (i) => `/projects/${i.project}/activity` },
  { name: "Task page", path: (i) => `/tasks/${i.task}`, wait: 'textarea[aria-label="Title"]' },
  { name: "Team", path: () => "/team" },
  { name: "Workload", path: () => "/workload", wait: ".workload-table" },
  { name: "Workload task list", path: i => `/workload?assignee=${i.person}`, wait: ".workload-task-title" },
  { name: "Workload task panel", path: i => `/workload?assignee=${i.person}&task=${i.task}`, wait: 'textarea[aria-label="Title"]' },
  { name: "Team member", path: (i) => `/team/${i.person}` },
  { name: "Approvals", path: () => "/approvals" },
  { name: "Reporting", path: () => "/review/reporting" },
  { name: "Search", path: () => "/search" },
  { name: "Profile", path: () => "/profile" },
  { name: "Deals", path: () => "/deals" },
  { name: "New deal", path: () => "/deals/new" },
  { name: "Deal", path: (i) => `/projects/${i.deal}` },
  { name: "Accounts", path: () => "/accounts" },
  { name: "Account", path: (i) => `/accounts/${i.org}` },
  { name: "Pipeline review", path: () => "/review", wait: ".review-actions a" },
  { name: "Usage", path: () => "/usage" },
  { name: "Audit log", path: () => "/audit" },
];
