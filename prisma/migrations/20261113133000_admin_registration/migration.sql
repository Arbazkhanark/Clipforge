-- Durable, email-verified first-Admin registration. No Admin role is created until token verification.
CREATE TABLE "AdminRegistration" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminRegistration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminRegistration_email_key" ON "AdminRegistration"("email");
CREATE UNIQUE INDEX "AdminRegistration_tokenHash_key" ON "AdminRegistration"("tokenHash");
CREATE INDEX "AdminRegistration_expiresAt_idx" ON "AdminRegistration"("expiresAt");
