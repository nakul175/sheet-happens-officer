// SHO-US-22.11: the screens and widths the phone checks cover. Add a screen here when you add a page.
export const WIDTHS = [320, 360, 390, 414, 599, 768] as const;
export const PHONE_MAX = 600; // under this width the 44 px and 16 px rules apply

export type Ids = { project: string; task: string; deal: string; org: string };
export type Screen = { name: string; path: (ids: Ids) => string; as?: "root" | "viewer"; public?: boolean; wait?: string };

export const SCREENS: Screen[] = [
  { name: "Sign in", path: () => "/signin", public: true },
  { name: "Sign up", path: () => "/signup", public: true },
  { name: "Forgot password", path: () => "/forgot", public: true },
  { name: "My tasks", path: () => "/" },
  { name: "My tasks with task panel", path: (i) => `/?task=${i.task}` },
  { name: "Projects", path: () => "/projects" },
  { name: "New project", path: () => "/projects/new" },
  { name: "Project list", path: (i) => `/projects/${i.project}` },
  { name: "Project board", path: (i) => `/projects/${i.project}?view=board` },
  { name: "Project board as Viewer", path: (i) => `/projects/${i.project}?view=board`, as: "viewer" },
  { name: "Project task panel", path: (i) => `/projects/${i.project}?task=${i.task}` },
  { name: "Project members", path: (i) => `/projects/${i.project}/members` },
  { name: "Project trash", path: (i) => `/projects/${i.project}/trash` },
  { name: "Project activity", path: (i) => `/projects/${i.project}/activity` },
  { name: "Task page", path: (i) => `/tasks/${i.task}` },
  { name: "Workload", path: () => "/workload", wait: ".workload tbody tr" },
  { name: "Team", path: () => "/team" },
  { name: "Search", path: () => "/search" },
  { name: "Profile", path: () => "/profile" },
  { name: "Deals", path: () => "/deals" },
  { name: "New deal", path: () => "/deals/new" },
  { name: "Deal", path: (i) => `/projects/${i.deal}` },
  { name: "Accounts", path: () => "/accounts" },
  { name: "Account", path: (i) => `/accounts/${i.org}` },
  { name: "Pipeline review", path: () => "/review" },
  { name: "Usage", path: () => "/usage" },
  { name: "Audit log", path: () => "/audit" },
];
