-- SHO-US-14.12: each person can choose compact rows; kept on the person so it follows them across devices.
ALTER TABLE "User" ADD COLUMN "compactRows" BOOLEAN NOT NULL DEFAULT false;
