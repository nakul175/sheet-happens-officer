# Taskboard

Internal work-management tool (Asana-style). Built layer by layer.

## Status

- [x] **Layer 1**: data model + REST API (workspaces, users, projects, tasks, subtasks, assignees, status, priority, due dates, ordering)
- [ ] Layer 2: list and kanban views
- [ ] Layer 3: comments, activity log, notifications
- [ ] Layer 4: real-time sync, search
- [ ] Layer 5: integrations, mobile

## Design decisions

- `workspaceId` is on every table and every query filters by it. Nothing enforces separation between teams yet; that is a deliberate scope choice, and the column means it can be added later without a migration.
- Auth is email-only with an httpOnly cookie (`src/lib/auth.ts`). Replace it before exposing the app outside the team.
- Subtasks are one level deep and always live in their parent's project.
- Ordering uses float `position` values, so a drag-and-drop move updates one row.

## Run locally

```bash
cp .env.example .env        # point DATABASE_URL at a Postgres database
npm install
npx prisma migrate dev
npm run dev
```

## Test

Tests are integration tests against a running server and database:

```bash
npm run dev -- -p 3100 &
TASKBOARD_URL=http://localhost:3100 npm test
```

## API (JSON, cookie session)

| Method | Path | Purpose |
|---|---|---|
| POST / GET / DELETE | `/api/session` | Sign in by email (name required the first time) / current user / sign out |
| GET | `/api/users` | Users in the workspace |
| GET / POST | `/api/projects` | List (`?archived=true` includes archived) / create |
| GET / PATCH / DELETE | `/api/projects/:id` | PATCH accepts `archived: true/false` |
| GET / POST | `/api/tasks` | Filters: `projectId, status, assigneeId, parentId, topLevel, dueBefore, q, limit, cursor` |
| GET / PATCH / DELETE | `/api/tasks/:id` | PATCH accepts `beforeId` / `afterId` to reorder, `projectId` to move |
| PUT | `/api/tasks/:id/assignees` | Replace the assignee set |
