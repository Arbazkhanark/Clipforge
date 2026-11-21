-- Additive account-suspension state. A row is the current state; immutable
-- suspension/reactivation transitions are written to AuditLog transactionally.
CREATE TABLE "UserSuspension" (
    "userId" TEXT NOT NULL,
    "suspendedByAdminId" TEXT NOT NULL,
    "reason" TEXT,
    "suspendedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserSuspension_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "UserSuspension_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "UserSuspension_suspendedByAdminId_suspendedAt_idx" ON "UserSuspension"("suspendedByAdminId", "suspendedAt");
