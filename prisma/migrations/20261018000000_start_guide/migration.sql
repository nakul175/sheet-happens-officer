-- SHO-US-14.4: the first-run start guide stays dismissed on every device.
ALTER TABLE "User" ADD COLUMN "startGuideDismissedAt" TIMESTAMP(3);
