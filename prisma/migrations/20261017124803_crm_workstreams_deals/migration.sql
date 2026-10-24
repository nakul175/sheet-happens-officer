-- CreateEnum
CREATE TYPE "StageCategory" AS ENUM ('NOT_STARTED', 'ACTIVE', 'PAUSED', 'DONE', 'LOST');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('INR', 'USD', 'EUR');

-- CreateEnum
CREATE TYPE "PartyRole" AS ENUM ('BUYER', 'FUNDER', 'IMPLEMENTING_OFFICE', 'PARTNER', 'OTHER');

-- CreateEnum
CREATE TYPE "OrgLevel" AS ENUM ('GROUP', 'LEGAL_ENTITY', 'BUYING_OFFICE');

-- CreateEnum
CREATE TYPE "NoteKind" AS ENUM ('MEETING', 'CALL', 'INTRODUCTION', 'OTHER');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "pipelineId" TEXT,
ADD COLUMN     "stageChangedAt" TIMESTAMP(3),
ADD COLUMN     "stageId" TEXT,
ADD COLUMN     "stageReason" TEXT,
ADD COLUMN     "typeId" TEXT NOT NULL DEFAULT 'wst_project';

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "isIdea" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "WorkstreamType" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "WorkstreamType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stage" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "category" "StageCategory" NOT NULL,
    "needsReason" BOOLEAN NOT NULL DEFAULT false,
    "requiredFields" TEXT[],

    CONSTRAINT "Stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealDetails" (
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "whyPursue" TEXT NOT NULL,
    "need" TEXT,
    "serviceLine" TEXT,
    "value" DECIMAL(16,2),
    "currency" "Currency",
    "probability" INTEGER,
    "expectedClose" DATE,
    "introducedBy" TEXT,
    "submissionDeadline" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealDetails_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "DealParty" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "role" "PartyRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealParty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organisation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT,
    "country" TEXT,
    "level" "OrgLevel",
    "parentId" TEXT,
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "createdById" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactKnownBy" (
    "contactId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ContactKnownBy_pkey" PRIMARY KEY ("contactId","userId")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT,
    "kind" "NoteKind" NOT NULL,
    "date" DATE NOT NULL,
    "text" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteContact" (
    "noteId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,

    CONSTRAINT "NoteContact_pkey" PRIMARY KEY ("noteId","contactId")
);

-- CreateTable
CREATE TABLE "TaskLink" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "organisationId" TEXT,
    "contactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkstreamType_key_key" ON "WorkstreamType"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_key_key" ON "Pipeline"("key");

-- CreateIndex
CREATE INDEX "Pipeline_typeId_idx" ON "Pipeline"("typeId");

-- CreateIndex
CREATE INDEX "Stage_pipelineId_position_idx" ON "Stage"("pipelineId", "position");

-- CreateIndex
CREATE INDEX "DealDetails_workspaceId_idx" ON "DealDetails"("workspaceId");

-- CreateIndex
CREATE INDEX "DealParty_organisationId_idx" ON "DealParty"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "DealParty_projectId_organisationId_role_key" ON "DealParty"("projectId", "organisationId", "role");

-- CreateIndex
CREATE INDEX "Organisation_workspaceId_name_idx" ON "Organisation"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Organisation_parentId_idx" ON "Organisation"("parentId");

-- CreateIndex
CREATE INDEX "Contact_organisationId_idx" ON "Contact"("organisationId");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_idx" ON "Contact"("workspaceId");

-- CreateIndex
CREATE INDEX "Note_organisationId_date_idx" ON "Note"("organisationId", "date");

-- CreateIndex
CREATE INDEX "Note_projectId_idx" ON "Note"("projectId");

-- CreateIndex
CREATE INDEX "TaskLink_taskId_idx" ON "TaskLink"("taskId");

-- CreateIndex
CREATE INDEX "TaskLink_organisationId_idx" ON "TaskLink"("organisationId");

-- CreateIndex
CREATE INDEX "TaskLink_contactId_idx" ON "TaskLink"("contactId");

-- CreateIndex
CREATE INDEX "Project_typeId_idx" ON "Project"("typeId");

-- CreateIndex
CREATE INDEX "Project_stageId_idx" ON "Project"("stageId");

-- Seed: workstream types, pipelines and stages (SHO-US-10.1, 10.2).
-- Must come before the Project foreign keys because every existing project defaults to type Project.
INSERT INTO "WorkstreamType" ("id","key","name") VALUES
  ('wst_project','PROJECT','Project'),
  ('wst_deal','DEAL','Deal');

INSERT INTO "Pipeline" ("id","typeId","key","name","position") VALUES
  ('pl_status','wst_project','PROJECT_STATUS','Status',0),
  ('pl_proactive','wst_deal','DEAL_PROACTIVE','Proactive',0),
  ('pl_bid','wst_deal','DEAL_BID','Bid',1);

INSERT INTO "Stage" ("id","pipelineId","name","position","category","needsReason","requiredFields") VALUES
  ('st_status_active','pl_status','Active',0,'ACTIVE',false,'{}'),
  ('st_status_hold','pl_status','On hold',1,'PAUSED',true,'{}'),
  ('st_status_done','pl_status','Done',2,'DONE',false,'{}'),
  ('st_pro_lead','pl_proactive','Lead',0,'ACTIVE',false,'{}'),
  ('st_pro_conversation','pl_proactive','Conversation',1,'ACTIVE',false,'{}'),
  ('st_pro_concept','pl_proactive','Concept note',2,'ACTIVE',false,'{}'),
  ('st_pro_proposal','pl_proactive','Proposal',3,'ACTIVE',false,'{}'),
  ('st_pro_negotiation','pl_proactive','Negotiation',4,'ACTIVE',false,'{}'),
  ('st_pro_hold','pl_proactive','On hold',5,'PAUSED',true,'{}'),
  ('st_pro_won','pl_proactive','Won',6,'DONE',false,'{}'),
  ('st_pro_lost','pl_proactive','Lost',7,'LOST',true,'{}'),
  ('st_bid_identified','pl_bid','Identified',0,'ACTIVE',false,'{}'),
  ('st_bid_gonogo','pl_bid','Go/No-go',1,'ACTIVE',false,'{}'),
  ('st_bid_preparing','pl_bid','Preparing',2,'ACTIVE',false,'{}'),
  ('st_bid_submitted','pl_bid','Submitted',3,'ACTIVE',false,'{}'),
  ('st_bid_awaiting','pl_bid','Awaiting result',4,'ACTIVE',false,'{}'),
  ('st_bid_won','pl_bid','Won',5,'DONE',false,'{}'),
  ('st_bid_lost','pl_bid','Lost',6,'LOST',true,'{}');

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "WorkstreamType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "WorkstreamType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealDetails" ADD CONSTRAINT "DealDetails_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealParty" ADD CONSTRAINT "DealParty_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealParty" ADD CONSTRAINT "DealParty_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactKnownBy" ADD CONSTRAINT "ContactKnownBy_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteContact" ADD CONSTRAINT "NoteContact_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteContact" ADD CONSTRAINT "NoteContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskLink" ADD CONSTRAINT "TaskLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskLink" ADD CONSTRAINT "TaskLink_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskLink" ADD CONSTRAINT "TaskLink_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rules Prisma cannot express.
-- Exactly one Buyer per deal (SHO-US-12.4 AC1).
CREATE UNIQUE INDEX "DealParty_one_buyer_per_deal" ON "DealParty"("projectId") WHERE "role" = 'BUYER';
-- A task link points at exactly one thing (SHO-US-11.4).
ALTER TABLE "TaskLink" ADD CONSTRAINT "TaskLink_exactly_one_target"
  CHECK (("organisationId" IS NOT NULL)::int + ("contactId" IS NOT NULL)::int = 1);
CREATE UNIQUE INDEX "TaskLink_unique_org" ON "TaskLink"("taskId","organisationId") WHERE "organisationId" IS NOT NULL;
CREATE UNIQUE INDEX "TaskLink_unique_contact" ON "TaskLink"("taskId","contactId") WHERE "contactId" IS NOT NULL;
-- Value and probability sanity (SHO-US-12.1 AC4: unknown is null, never zero-by-default).
ALTER TABLE "DealDetails" ADD CONSTRAINT "DealDetails_probability_range" CHECK ("probability" IS NULL OR ("probability" BETWEEN 0 AND 100));
ALTER TABLE "DealDetails" ADD CONSTRAINT "DealDetails_value_has_currency" CHECK ("value" IS NULL OR "currency" IS NOT NULL);
-- A project's stage belongs to its pipeline; a pipeline belongs to its type.
ALTER TABLE "Project" ADD CONSTRAINT "Project_stage_needs_pipeline" CHECK ("stageId" IS NULL OR "pipelineId" IS NOT NULL);
