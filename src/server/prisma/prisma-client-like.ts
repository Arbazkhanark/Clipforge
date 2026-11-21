// The small slice of the Prisma Client API that our repositories use, written down as plain TypeScript types.
// WHY: Prisma could not be installed here (no network), so the repositories are written against this narrow
// interface and tested with a fake that follows the documented behaviour (updateMany returns { count },
// unique violations throw an error with code "P2002", $transaction runs a callback). The REAL PrismaClient has
// never been run against these repositories: see docs/VERIFICATION.md. Types here are intentionally loose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export type Where = Record<string, unknown>;

export interface ModelDelegate {
  findUnique(args: { where: Where; select?: Record<string, boolean> }): Promise<Row | null>;
  findFirst(args: { where?: Where; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[] }): Promise<Row | null>;
  findMany(args?: { where?: Where; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[]; skip?: number; take?: number }): Promise<Row[]>;
  count(args?: { where?: Where }): Promise<number>;
  create(args: { data: Row }): Promise<Row>;
  createMany(args: { data: Row[] }): Promise<{ count: number }>;
  update(args: { where: Where; data: Row }): Promise<Row>;
  updateMany(args: { where?: Where; data: Row }): Promise<{ count: number }>;
  upsert(args: { where: Where; create: Row; update: Row }): Promise<Row>;
  aggregate(args: { where?: Where; _sum: Record<string, true> }): Promise<{ _sum: Record<string, bigint | number | null> }>;
  groupBy(args: { by: string[]; where?: Where; _count: { _all: true } }): Promise<Row[]>;
  deleteMany(args?: { where?: Where }): Promise<{ count: number }>;
}

export interface PrismaClientLike {
  user: ModelDelegate; userSuspension: ModelDelegate; session: ModelDelegate; authToken: ModelDelegate; googleIdentity: ModelDelegate;
  mediaAsset: ModelDelegate; mediaDerivative: ModelDelegate; mediaImportJob: ModelDelegate; editedMediaReplacement: ModelDelegate; videoCollection: ModelDelegate; collectionItem: ModelDelegate; collectionPermission: ModelDelegate; collectionAccessRequest: ModelDelegate; collectionShareLink: ModelDelegate;
  publishingCycle: ModelDelegate; cycleItem: ModelDelegate; publishingJob: ModelDelegate; processingJob: ModelDelegate; captionRevision: ModelDelegate;
  auditLog: ModelDelegate; editingTemplate: ModelDelegate; socialAccount: ModelDelegate; subscription: ModelDelegate; razorpaySubscriptionIntent: ModelDelegate; razorpaySubscriptionContinuation: ModelDelegate; manualPaymentIntent: ModelDelegate; manualPlanAccess: ModelDelegate; promotion: ModelDelegate; promotionRedemption: ModelDelegate; promotionalAccessGrant: ModelDelegate; promotionLifecycleEvent: ModelDelegate; complimentaryAccessGrant: ModelDelegate; complimentaryAccessEvent: ModelDelegate; webhookEvent: ModelDelegate; paymentRecord: ModelDelegate; usageRecord: ModelDelegate;
  /** Present after the forward-only first-Admin registration migration is applied. */
  adminRegistration?: ModelDelegate;
  /** Runs `work` in a database transaction. */
  $transaction<T>(work: (tx: PrismaClientLike) => Promise<T>): Promise<T>;
  /** Tagged-template raw query (used only to lock a user row: SELECT ... FOR UPDATE). */
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  /** Prisma Client exposes this; optional for focused repository fakes. */
  $disconnect?(): Promise<void>;
}

/** Prisma reports a violated UNIQUE constraint with this error code. */
export const isUniqueViolation = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
