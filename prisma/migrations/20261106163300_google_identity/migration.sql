-- Google account identity for OAuth sign-in.
-- Stores Google's stable subject (ID token "sub") only.
-- Does not store access tokens, refresh tokens, or authorization codes.

CREATE TABLE "GoogleIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "googleSub" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleIdentity_userId_key" ON "GoogleIdentity"("userId");

CREATE UNIQUE INDEX "GoogleIdentity_googleSub_key" ON "GoogleIdentity"("googleSub");

ALTER TABLE "GoogleIdentity" ADD CONSTRAINT "GoogleIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
