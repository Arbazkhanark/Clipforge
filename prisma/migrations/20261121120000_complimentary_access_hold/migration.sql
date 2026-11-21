-- Permanent complimentary access is intentionally independent of payment/subscription rows.
CREATE TABLE "ComplimentaryAccessGrant" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "grantedByAdminId" TEXT NOT NULL,
  "reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ComplimentaryAccessGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ComplimentaryAccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ComplimentaryAccessGrant_grantedByAdminId_fkey" FOREIGN KEY ("grantedByAdminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ComplimentaryAccessGrant_planId_check" CHECK ("planId" IN ('creator', 'pro', 'agency')),
  CONSTRAINT "ComplimentaryAccessGrant_status_check" CHECK ("status" IN ('ACTIVE', 'ON_HOLD', 'REVOKED')),
  CONSTRAINT "ComplimentaryAccessGrant_version_check" CHECK ("version" >= 1),
  CONSTRAINT "ComplimentaryAccessGrant_reason_check" CHECK ("reason" IS NULL OR length("reason") <= 500)
);

CREATE INDEX "ComplimentaryAccessGrant_userId_status_createdAt_idx"
  ON "ComplimentaryAccessGrant"("userId", "status", "createdAt");
CREATE UNIQUE INDEX "ComplimentaryAccessGrant_one_unrevoked_per_user"
  ON "ComplimentaryAccessGrant"("userId") WHERE "status" IN ('ACTIVE', 'ON_HOLD');

CREATE TABLE "ComplimentaryAccessEvent" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "subjectUserId" TEXT NOT NULL,
  "actorAdminId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "previousState" TEXT,
  "newState" TEXT NOT NULL,
  "note" TEXT,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ComplimentaryAccessEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ComplimentaryAccessEvent_eventKey_key" UNIQUE ("eventKey"),
  CONSTRAINT "ComplimentaryAccessEvent_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "ComplimentaryAccessGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ComplimentaryAccessEvent_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ComplimentaryAccessEvent_actorAdminId_fkey" FOREIGN KEY ("actorAdminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ComplimentaryAccessEvent_action_state_check" CHECK (
    ("action" = 'GRANT' AND "previousState" IS NULL AND "newState" = 'ACTIVE') OR
    ("action" = 'HOLD' AND "previousState" = 'ACTIVE' AND "newState" = 'ON_HOLD') OR
    ("action" = 'RESUME' AND "previousState" = 'ON_HOLD' AND "newState" = 'ACTIVE') OR
    ("action" = 'REVOKE' AND "previousState" IS NOT NULL AND "previousState" IN ('ACTIVE', 'ON_HOLD') AND "newState" = 'REVOKED')
  ),
  CONSTRAINT "ComplimentaryAccessEvent_note_check" CHECK ("note" IS NULL OR length("note") <= 500)
);

CREATE INDEX "ComplimentaryAccessEvent_grantId_occurredAt_idx"
  ON "ComplimentaryAccessEvent"("grantId", "occurredAt");
CREATE INDEX "ComplimentaryAccessEvent_subjectUserId_occurredAt_idx"
  ON "ComplimentaryAccessEvent"("subjectUserId", "occurredAt");
CREATE INDEX "ComplimentaryAccessEvent_actorAdminId_occurredAt_idx"
  ON "ComplimentaryAccessEvent"("actorAdminId", "occurredAt");

CREATE FUNCTION "reject_complimentary_access_event_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ComplimentaryAccessEvent rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ComplimentaryAccessEvent_append_only"
  BEFORE UPDATE OR DELETE ON "ComplimentaryAccessEvent"
  FOR EACH ROW EXECUTE FUNCTION "reject_complimentary_access_event_mutation"();
