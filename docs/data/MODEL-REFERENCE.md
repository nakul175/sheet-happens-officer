# Model and relation reference

Generated from `prisma/schema.prisma`; do not edit field tables by hand. See CONTRACT.md for semantics and unresolved boundaries.

## Workspace

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| name | String | — |
| createdAt | DateTime | @default(now()) |
| users | User[] | — |
| projects | Project[] | — |
| tasks | Task[] | — |
| organisations | Organisation[] | — |
| contacts | Contact[] | — |
| notes | Note[] | — |

## User

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| workspaceId | String | — |
| workspace | Workspace | @relation(fields: [workspaceId], references: [id]) |
| email | String | @unique |
| name | String | — |
| passwordHash | String | — |
| emailVerifiedAt | DateTime? | — |
| orgRole | OrgRole | @default(MEMBER) |
| deactivatedAt | DateTime? | — |
| tempPasswordAt | DateTime? | — |
| conciergeHidden | Boolean | @default(false) |
| voiceNoticeAckedAt | DateTime? | — |
| compactRows | Boolean | @default(false) |
| startGuideDismissedAt | DateTime? | — |
| createdAt | DateTime | @default(now()) |
| memberships | ProjectMember[] | — |
| assignedTasks | Task[] | @relation("TaskAssignee") |
| approvingTasks | Task[] | @relation("TaskApprover") |
| previouslyAssigned | Task[] | @relation("TaskPreviousAssignee") |
| createdTasks | Task[] | @relation("TaskCreator") |
| deletedTasks | Task[] | @relation("TaskDeleter") |
| collaborations | TaskCollaborator[] | — |
| sessions | Session[] | — |
| authTokens | AuthToken[] | — |
| notifications | Notification[] | @relation("NotificationRecipient") |
| notificationsCaused | Notification[] | @relation("NotificationActor") |
| actionLogs | ActionLog[] | @relation("ActionActor") |
| actionsUndone | ActionLog[] | @relation("ActionUndoneBy") |
| auditLogs | AuditLog[] | — |
| chatMessages | ChatMessage[] | — |
| modelUsage | ModelUsage[] | — |
| savedViews | SavedView[] | — |
| authoredComments | Comment[] | @relation("CommentAuthor") |

Model constraints: `@@index([workspaceId])`.

## Session

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| userId | String | — |
| user | User | @relation(fields: [userId], references: [id], onDelete: Cascade) |
| tokenHash | String | @unique |
| expiresAt | DateTime | — |
| revokedAt | DateTime? | — |
| userAgent | String? | — |
| lastSeenAt | DateTime | @default(now()) |
| createdAt | DateTime | @default(now()) |
| centralLink | CentralSessionLink? | — |

Model constraints: `@@index([userId])`; `@@index([expiresAt])`.

## AuthToken

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| userId | String | — |
| user | User | @relation(fields: [userId], references: [id], onDelete: Cascade) |
| type | AuthTokenType | — |
| tokenHash | String | @unique |
| expiresAt | DateTime | — |
| usedAt | DateTime? | — |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@index([userId, type])`.

## LoginAttempt

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| email | String | — |
| success | Boolean | — |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@index([email, createdAt])`.

## Project

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| workspaceId | String | — |
| workspace | Workspace | @relation(fields: [workspaceId], references: [id]) |
| name | String | — |
| description | String? | — |
| archivedAt | DateTime? | — |
| deletedAt | DateTime? | — |
| deletedPreviousArchivedAt | DateTime? | — |
| isVertical | Boolean | @default(false) |
| verticalId | String? | — |
| vertical | Project? | @relation("ProjectVertical", fields: [verticalId], references: [id], onDelete: SetNull) |
| deliveryProjects | Project[] | @relation("ProjectVertical") |
| typeId | String | @default("wst_project") |
| type | WorkstreamType | @relation(fields: [typeId], references: [id]) |
| pipelineId | String? | — |
| pipeline | Pipeline? | @relation(fields: [pipelineId], references: [id]) |
| stageId | String? | — |
| stage | Stage? | @relation(fields: [stageId], references: [id]) |
| stageReason | String? | — |
| stageChangedAt | DateTime? | — |
| deal | DealDetails? | — |
| parties | DealParty[] | — |
| notes | Note[] | — |
| createdAt | DateTime | @default(now()) |
| updatedAt | DateTime | @updatedAt |
| members | ProjectMember[] | — |
| sections | Section[] | — |
| tasks | Task[] | — |
| actionLogs | ActionLog[] | — |
| savedViews | SavedView[] | — |
| holySheetLinks | HolySheetLink[] | — |
| holySheetDefault | HolySheetDefault? | — |

Model constraints: `@@index([workspaceId])`; `@@index([typeId])`; `@@index([stageId])`; `@@index([verticalId])`.

## HolySheetLink

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| projectId | String | — |
| project | Project | @relation(fields: [projectId], references: [id], onDelete: Cascade) |
| taskId | String? | — |
| task | Task? | @relation(fields: [taskId], references: [id], onDelete: Cascade) |
| originKey | String | — |
| pageId | String | — |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@unique([projectId, originKey, pageId])`.

## HolySheetDefault

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| projectId | String | @id |
| project | Project | @relation(fields: [projectId], references: [id], onDelete: Cascade) |
| spaceId | String | — |

## ProjectMember

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| projectId | String | — |
| project | Project | @relation(fields: [projectId], references: [id], onDelete: Cascade) |
| userId | String | — |
| user | User | @relation(fields: [userId], references: [id], onDelete: Cascade) |
| role | ProjectRole | — |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@id([projectId, userId])`; `@@index([userId])`.

## Section

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| projectId | String | — |
| project | Project | @relation(fields: [projectId], references: [id], onDelete: Cascade) |
| name | String | — |
| position | Int | — |
| isDone | Boolean | @default(false) |
| createdAt | DateTime | @default(now()) |
| tasks | Task[] | — |

Model constraints: `@@index([projectId, position])`.

## Task

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| holySheetLinks | HolySheetLink[] | — |
| id | String | @id @default(cuid()) |
| workspaceId | String | — |
| workspace | Workspace | @relation(fields: [workspaceId], references: [id]) |
| projectId | String | — |
| project | Project | @relation(fields: [projectId], references: [id], onDelete: Cascade) |
| sectionId | String | — |
| section | Section | @relation(fields: [sectionId], references: [id]) |
| parentId | String? | — |
| parent | Task? | @relation("Subtasks", fields: [parentId], references: [id], onDelete: Cascade) |
| subtasks | Task[] | @relation("Subtasks") |
| title | String | — |
| description | String? | — |
| priority | TaskPriority | @default(MEDIUM) |
| blocked | Boolean | @default(false) |
| blockedReason | String? | — |
| dueDate | DateTime? | — |
| position | Float | @default(0) |
| assigneeId | String | — |
| assignee | User | @relation("TaskAssignee", fields: [assigneeId], references: [id]) |
| approverId | String? | — |
| approver | User? | @relation("TaskApprover", fields: [approverId], references: [id]) |
| previousAssigneeId | String? | — |
| previousAssignee | User? | @relation("TaskPreviousAssignee", fields: [previousAssigneeId], references: [id]) |
| createdById | String | — |
| createdBy | User | @relation("TaskCreator", fields: [createdById], references: [id]) |
| deletedAt | DateTime? | — |
| deletedById | String? | — |
| deletedBy | User? | @relation("TaskDeleter", fields: [deletedById], references: [id]) |
| completedAt | DateTime? | — |
| previousSectionId | String? | — |
| isIdea | Boolean | @default(false) |
| links | TaskLink[] | — |
| createdAt | DateTime | @default(now()) |
| updatedAt | DateTime | @updatedAt |
| collaborators | TaskCollaborator[] | — |
| comments | Comment[] | — |

Model constraints: `@@index([workspaceId])`; `@@index([projectId, sectionId, position])`; `@@index([parentId])`; `@@index([dueDate])`; `@@index([assigneeId])`; `@@index([approverId])`; `@@index([deletedAt])`.

## Comment

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| taskId | String | — |
| task | Task | @relation(fields: [taskId], references: [id], onDelete: Cascade) |
| authorId | String | — |
| author | User | @relation("CommentAuthor", fields: [authorId], references: [id]) |
| text | String | — |
| mentions | String[] | @default([]) |
| editedAt | DateTime? | — |
| removedAt | DateTime? | — |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@index([taskId, removedAt, createdAt])`.

## TaskCollaborator

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| taskId | String | — |
| task | Task | @relation(fields: [taskId], references: [id], onDelete: Cascade) |
| userId | String | — |
| user | User | @relation(fields: [userId], references: [id], onDelete: Cascade) |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@id([taskId, userId])`; `@@index([userId])`.

## Notification

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| recipientId | String | — |
| recipient | User | @relation("NotificationRecipient", fields: [recipientId], references: [id], onDelete: Cascade) |
| actorId | String? | — |
| actor | User? | @relation("NotificationActor", fields: [actorId], references: [id]) |
| type | String | — |
| taskId | String? | — |
| projectId | String? | — |
| data | Json? | — |
| readAt | DateTime? | — |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@index([recipientId, createdAt])`; `@@index([createdAt])`.

## ActionLog

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| actorId | String | — |
| actor | User | @relation("ActionActor", fields: [actorId], references: [id]) |
| channel | ActionChannel | — |
| projectId | String? | — |
| project | Project? | @relation(fields: [projectId], references: [id]) |
| targetType | String | — |
| targetId | String | — |
| action | String | — |
| beforeState | Json? | — |
| afterState | Json? | — |
| undoneAt | DateTime? | — |
| undoneById | String? | — |
| undoneBy | User? | @relation("ActionUndoneBy", fields: [undoneById], references: [id]) |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@index([projectId, createdAt])`; `@@index([actorId, createdAt])`; `@@index([createdAt])`.

## AuditLog

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| actorId | String? | — |
| actor | User? | @relation(fields: [actorId], references: [id]) |
| event | String | — |
| targetType | String? | — |
| targetId | String? | — |
| channel | ActionChannel? | — |
| ip | String? | — |
| data | Json? | — |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@index([createdAt])`; `@@index([actorId, createdAt])`; `@@index([event, createdAt])`.

## ChatMessage

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| userId | String | — |
| user | User | @relation(fields: [userId], references: [id], onDelete: Cascade) |
| role | ChatRole | — |
| content | String | — |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@index([userId, createdAt])`; `@@index([createdAt])`.

## ModelUsage

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| userId | String | — |
| user | User | @relation(fields: [userId], references: [id]) |
| model | String | — |
| inputTokens | Int | — |
| outputTokens | Int | — |
| costUsd | Decimal | @db.Decimal(12, 6) |
| counted | Boolean | @default(false) |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@index([userId, counted, createdAt])`; `@@index([userId, createdAt])`; `@@index([createdAt])`.

## JobRun

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| job | String | @id |
| lastStartedAt | DateTime? | — |
| lastFinishedAt | DateTime? | — |
| lastStatus | String? | — |
| lastError | String? | — |

## WorkstreamType

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id |
| key | String | @unique |
| name | String | — |
| projects | Project[] | — |
| pipelines | Pipeline[] | — |

## Pipeline

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id |
| typeId | String | — |
| type | WorkstreamType | @relation(fields: [typeId], references: [id]) |
| key | String | @unique |
| name | String | — |
| position | Int | — |
| stages | Stage[] | — |
| projects | Project[] | — |

Model constraints: `@@index([typeId])`.

## Stage

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id |
| pipelineId | String | — |
| pipeline | Pipeline | @relation(fields: [pipelineId], references: [id]) |
| name | String | — |
| position | Int | — |
| category | StageCategory | — |
| needsReason | Boolean | @default(false) |
| requiredFields | String[] | — |
| isRetired | Boolean | @default(false) |
| projects | Project[] | — |

Model constraints: `@@index([pipelineId, position])`.

## DealDetails

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| projectId | String | @id |
| project | Project | @relation(fields: [projectId], references: [id], onDelete: Cascade) |
| workspaceId | String | — |
| whyPursue | String | — |
| need | String? | — |
| serviceLine | String? | — |
| value | Decimal? | @db.Decimal(16, 2) |
| currency | Currency? | — |
| probability | Int? | — |
| opportunityType | OpportunityType? | — |
| athenaEntity | AthenaEntity? | — |
| netFeeRevenueUsd | Decimal? | @db.Decimal(15, 2) |
| partner | String? | — |
| athenaRole | AthenaRole? | — |
| budgetUsd | Decimal? | @db.Decimal(15, 2) |
| pwinAdjustedNfrUsd | Decimal? | @db.Decimal(15, 2) |
| expectedClose | DateTime? | @db.Date |
| introducedBy | String? | — |
| submissionDeadline | DateTime? | @db.Date |
| submissionDeadlineAt | DateTime? | @db.Timestamptz(3) |
| submissionDeadlineZone | String? | — |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@index([workspaceId])`.

## DealParty

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| projectId | String | — |
| project | Project | @relation(fields: [projectId], references: [id], onDelete: Cascade) |
| organisationId | String | — |
| organisation | Organisation | @relation(fields: [organisationId], references: [id]) |
| role | PartyRole | — |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@unique([projectId, organisationId, role])`; `@@index([organisationId])`.

## Organisation

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| workspaceId | String | — |
| workspace | Workspace | @relation(fields: [workspaceId], references: [id]) |
| name | String | — |
| kind | String? | — |
| country | String? | — |
| level | OrgLevel? | — |
| parentId | String? | — |
| parent | Organisation? | @relation("OrgTree", fields: [parentId], references: [id]) |
| children | Organisation[] | @relation("OrgTree") |
| createdById | String | — |
| archivedAt | DateTime? | — |
| createdAt | DateTime | @default(now()) |
| updatedAt | DateTime | @updatedAt |
| contacts | Contact[] | — |
| parties | DealParty[] | — |
| notes | Note[] | — |
| links | TaskLink[] | — |

Model constraints: `@@index([workspaceId, name])`; `@@index([parentId])`.

## Contact

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| workspaceId | String | — |
| workspace | Workspace | @relation(fields: [workspaceId], references: [id]) |
| organisationId | String | — |
| organisation | Organisation | @relation(fields: [organisationId], references: [id]) |
| name | String | — |
| role | String? | — |
| email | String? | — |
| phone | String? | — |
| createdById | String | — |
| removedAt | DateTime? | — |
| createdAt | DateTime | @default(now()) |
| updatedAt | DateTime | @updatedAt |
| knownBy | ContactKnownBy[] | — |
| noteLinks | NoteContact[] | — |
| links | TaskLink[] | — |

Model constraints: `@@index([organisationId])`; `@@index([workspaceId])`.

## ContactKnownBy

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| contactId | String | — |
| contact | Contact | @relation(fields: [contactId], references: [id], onDelete: Cascade) |
| userId | String | — |

Model constraints: `@@id([contactId, userId])`.

## Note

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| workspaceId | String | — |
| workspace | Workspace | @relation(fields: [workspaceId], references: [id]) |
| organisationId | String | — |
| organisation | Organisation | @relation(fields: [organisationId], references: [id]) |
| projectId | String? | — |
| project | Project? | @relation(fields: [projectId], references: [id]) |
| kind | NoteKind | — |
| date | DateTime | @db.Date |
| text | String | — |
| authorId | String | — |
| removedAt | DateTime? | — |
| createdAt | DateTime | @default(now()) |
| contacts | NoteContact[] | — |

Model constraints: `@@index([organisationId, date])`; `@@index([projectId])`.

## NoteContact

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| noteId | String | — |
| note | Note | @relation(fields: [noteId], references: [id], onDelete: Cascade) |
| contactId | String | — |
| contact | Contact | @relation(fields: [contactId], references: [id]) |

Model constraints: `@@id([noteId, contactId])`.

## TaskLink

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| taskId | String | — |
| task | Task | @relation(fields: [taskId], references: [id], onDelete: Cascade) |
| organisationId | String? | — |
| organisation | Organisation? | @relation(fields: [organisationId], references: [id]) |
| contactId | String? | — |
| contact | Contact? | @relation(fields: [contactId], references: [id]) |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@index([taskId])`; `@@index([organisationId])`; `@@index([contactId])`.

## SavedView

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| userId | String | — |
| user | User | @relation(fields: [userId], references: [id], onDelete: Cascade) |
| projectId | String | — |
| project | Project | @relation(fields: [projectId], references: [id], onDelete: Cascade) |
| name | String | — |
| state | Json | — |
| position | Int | @default(0) |
| createdAt | DateTime | @default(now()) |
| updatedAt | DateTime | @updatedAt |

Model constraints: `@@unique([userId, projectId, name])`; `@@index([userId, projectId, position])`.

## SuiteGrant

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| id | String | @id @default(cuid()) |
| clientId | String | @default("bugoff") |
| codeHash | String | @unique |
| accessTokenHash | String? | @unique |
| userId | String | — |
| sessionId | String | — |
| challenge | String | — |
| expiresAt | DateTime | — |
| redeemedAt | DateTime? | — |
| accessExpiresAt | DateTime? | — |
| createdAt | DateTime | @default(now()) |

Model constraints: `@@index([expiresAt])`.

## CentralSessionLink

| Field | Prisma type | Attributes / relation deletion rule |
| --- | --- | --- |
| sessionId | String | @id |
| session | Session | @relation(fields: [sessionId], references: [id], onDelete: Cascade) |
| subject | String | — |
| sessionUid | String | — |
| createdAt | DateTime | @default(now()) |

## Custom SQL inventory

Read definitions in migration order; later ALTER/replacements take precedence. This inventory includes checks, partial indexes, triggers and functions.

### 20261017000000_init

```sql
CREATE UNIQUE INDEX "ProjectMember_one_leader_per_project"
  ON "ProjectMember" ("projectId") WHERE "role" = 'LEADER';
CREATE UNIQUE INDEX "Section_one_done_per_project"
  ON "Section" ("projectId") WHERE "isDone" = true;
CREATE FUNCTION "enforce_max_sections"() RETURNS trigger AS $$
CREATE TRIGGER "Section_max_8"
CREATE FUNCTION "enforce_task_section_in_project"() RETURNS trigger AS $$
CREATE TRIGGER "Task_section_in_project"
ALTER TABLE "User" ADD CONSTRAINT "User_email_lowercase" CHECK ("email" = lower("email"));
```

### 20261017124803_crm_workstreams_deals

```sql
CREATE UNIQUE INDEX "DealParty_one_buyer_per_deal" ON "DealParty"("projectId") WHERE "role" = 'BUYER';
  CHECK (("organisationId" IS NOT NULL)::int + ("contactId" IS NOT NULL)::int = 1);
CREATE UNIQUE INDEX "TaskLink_unique_org" ON "TaskLink"("taskId","organisationId") WHERE "organisationId" IS NOT NULL;
CREATE UNIQUE INDEX "TaskLink_unique_contact" ON "TaskLink"("taskId","contactId") WHERE "contactId" IS NOT NULL;
ALTER TABLE "DealDetails" ADD CONSTRAINT "DealDetails_probability_range" CHECK ("probability" IS NULL OR ("probability" BETWEEN 0 AND 100));
ALTER TABLE "DealDetails" ADD CONSTRAINT "DealDetails_value_has_currency" CHECK ("value" IS NULL OR "currency" IS NOT NULL);
ALTER TABLE "Project" ADD CONSTRAINT "Project_stage_needs_pipeline" CHECK ("stageId" IS NULL OR "pipelineId" IS NOT NULL);
```

### 20261018203100_pin_trigger_search_path

```sql
CREATE OR REPLACE FUNCTION "enforce_max_sections"() RETURNS trigger AS $$
CREATE OR REPLACE FUNCTION "enforce_task_section_in_project"() RETURNS trigger AS $$
```

### 20261024101000_deal_classification_revenue

```sql
  ADD CONSTRAINT "DealDetails_netFeeRevenueUsd_nonnegative" CHECK ("netFeeRevenueUsd" >= 0 AND "netFeeRevenueUsd" <> 'NaN'::numeric);
```

### 20261026110000_project_vertical_boards

```sql
CREATE UNIQUE INDEX "Project_live_vertical_name_idx" ON "Project"("workspaceId", lower("name")) WHERE "isVertical" = true AND "deletedAt" IS NULL;
```

### 20261027120000_holy_sheet_links

```sql
 CONSTRAINT "HolySheetLink_origin_check" CHECK (("taskId" IS NULL AND "originKey"='project') OR ("taskId" IS NOT NULL AND "originKey"='task:'||"taskId"))
CREATE FUNCTION holy_sheet_task_move() RETURNS trigger LANGUAGE plpgsql AS $$
CREATE TRIGGER holy_sheet_task_move AFTER UPDATE OF "projectId" ON "Task"
```

