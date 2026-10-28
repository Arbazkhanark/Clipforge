// CENTRAL PLAN CATALOG - the single source of truth for prices and limits.
// All money is stored as integer paise (1 rupee = 100 paise). Never use floats.

export const PLAN_IDS = ["free", "creator", "pro", "agency"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const BILLING_INTERVALS = ["weekly", "monthly"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export type SharingLevel = "none" | "basic" | "advanced";
export type MaxResolution = "720p" | "1080p" | "original";

const GIB = 1024 ** 3; // storage is measured in binary gigabytes (documented assumption)

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Price in paise per interval. Free plan has 0 for both. */
  pricePaise: Record<BillingInterval, number>;
  limits: {
    connectedAccounts: number;
    storageBytes: number;
    processingMinutesPerMonth: number;
    exportsPerMonth: number;
    batchSize: number;
    concurrentJobs: number;
    templates: number;
    activeCampaigns: number;
    scheduledItemsPerMonth: number;
  };
  features: {
    maxResolution: MaxResolution;
    showDashboardAds: boolean;
    googleDriveImport: boolean;
    advancedOrdering: boolean;
    perAccountQueues: boolean;
    advancedSchedulingAndRepeat: boolean;
    smartPublishingAssistant: boolean;
    jobLogsAndPriority: boolean;
    analytics: boolean;
    collectionSharing: SharingLevel;
    useSharedVideosInCycles: boolean;
    mixAndUnmix: boolean;
  };
  /**
   * Advanced sharing policy, enforced server-side by src/lib/domain/sharing-management.ts.
   * PLACEHOLDER NUMBERS: the recipient caps below were chosen by the developer, not the product
   * owner. They are configurable here in one place - please confirm or change them.
   */
  sharing: {
    /** Can the owner give grants an expiry date? */
    expiringGrants: boolean;
    /** Can the owner delegate the "manage" permission (with the limits in sharing-management.ts)? */
    delegatedManagement: boolean;
    /** Most people who can hold an active grant on ONE collection (the collection owner's plan applies). */
    maxRecipientsPerCollection: number;
  };
}

const rupees = (amount: number): number => amount * 100;

export const PLAN_CATALOG: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    pricePaise: { weekly: 0, monthly: 0 },
    limits: {
      connectedAccounts: 1, storageBytes: 5 * GIB, processingMinutesPerMonth: 30,
      exportsPerMonth: 10, batchSize: 5, concurrentJobs: 1, templates: 3,
      activeCampaigns: 1, scheduledItemsPerMonth: 10,
    },
    features: {
      maxResolution: "720p", showDashboardAds: true, googleDriveImport: false,
      advancedOrdering: false, perAccountQueues: false, advancedSchedulingAndRepeat: false,
      smartPublishingAssistant: false, jobLogsAndPriority: false, analytics: false,
      collectionSharing: "none", useSharedVideosInCycles: false, mixAndUnmix: false,
    },
    sharing: { expiringGrants: false, delegatedManagement: false, maxRecipientsPerCollection: 0 },
  },
  creator: {
    id: "creator",
    name: "Creator",
    pricePaise: { weekly: rupees(499), monthly: rupees(1999) },
    limits: {
      connectedAccounts: 1, storageBytes: 50 * GIB, processingMinutesPerMonth: 300,
      exportsPerMonth: 100, batchSize: 25, concurrentJobs: 2, templates: 25,
      activeCampaigns: 5, scheduledItemsPerMonth: 100,
    },
    features: {
      maxResolution: "1080p", showDashboardAds: false, googleDriveImport: true,
      advancedOrdering: true, perAccountQueues: false, advancedSchedulingAndRepeat: false,
      smartPublishingAssistant: false, jobLogsAndPriority: false, analytics: false,
      // POLICY (user decision): basic sharing + direct use of shared videos + Mix/Unmix start at Creator.
      // Advanced sharing management (Pro and up) and higher limits are the upgrade reasons.
      collectionSharing: "basic", useSharedVideosInCycles: true, mixAndUnmix: true,
    },
    sharing: { expiringGrants: false, delegatedManagement: false, maxRecipientsPerCollection: 5 },
  },
  pro: {
    id: "pro",
    name: "Pro",
    pricePaise: { weekly: rupees(999), monthly: rupees(3999) },
    limits: {
      connectedAccounts: 3, storageBytes: 200 * GIB, processingMinutesPerMonth: 1500,
      exportsPerMonth: 500, batchSize: 100, concurrentJobs: 5, templates: 100,
      activeCampaigns: 20, scheduledItemsPerMonth: 500,
    },
    features: {
      maxResolution: "original", showDashboardAds: false, googleDriveImport: true,
      advancedOrdering: true, perAccountQueues: true, advancedSchedulingAndRepeat: true,
      smartPublishingAssistant: true, jobLogsAndPriority: true, analytics: false,
      collectionSharing: "advanced", useSharedVideosInCycles: true, mixAndUnmix: true,
    },
    sharing: { expiringGrants: true, delegatedManagement: true, maxRecipientsPerCollection: 25 },
  },
  agency: {
    id: "agency",
    name: "Agency",
    pricePaise: { weekly: rupees(1499), monthly: rupees(5999) },
    limits: {
      connectedAccounts: 10, storageBytes: 1024 * GIB, processingMinutesPerMonth: 6000,
      exportsPerMonth: 2000, batchSize: 200, concurrentJobs: 10, templates: 500,
      activeCampaigns: 100, scheduledItemsPerMonth: 2000,
    },
    features: {
      maxResolution: "original", showDashboardAds: false, googleDriveImport: true,
      advancedOrdering: true, perAccountQueues: true, advancedSchedulingAndRepeat: true,
      smartPublishingAssistant: true, jobLogsAndPriority: true, analytics: true,
      // ASSUMPTION: Agency gets everything Pro has. Team features are NOT listed until built.
      collectionSharing: "advanced", useSharedVideosInCycles: true, mixAndUnmix: true,
    },
    sharing: { expiringGrants: true, delegatedManagement: true, maxRecipientsPerCollection: 100 },
  },
};

export class UnknownPlanError extends Error {
  constructor(planId: string) { super(`Unknown plan: "${planId}"`); this.name = "UnknownPlanError"; }
}
export class UnsupportedBillingIntervalError extends Error {
  constructor(interval: string) { super(`Unsupported billing interval: "${interval}"`); this.name = "UnsupportedBillingIntervalError"; }
}

export function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}
export function isBillingInterval(value: string): value is BillingInterval {
  return (BILLING_INTERVALS as readonly string[]).includes(value);
}

export function getPlan(planId: string): PlanDefinition {
  if (!isPlanId(planId)) throw new UnknownPlanError(planId);
  return PLAN_CATALOG[planId];
}

export function getPricePaise(planId: string, interval: string): number {
  if (!isBillingInterval(interval)) throw new UnsupportedBillingIntervalError(interval);
  return getPlan(planId).pricePaise[interval];
}

/** Display helper only. Uses integer math; never feed the result back into calculations. */
export function formatPaiseAsRupees(paise: number): string {
  if (!Number.isInteger(paise) || paise < 0) throw new RangeError("paise must be a non-negative integer");
  const whole = Math.floor(paise / 100);
  const fraction = paise % 100;
  const wholeText = new Intl.NumberFormat("en-IN").format(whole);
  return `₹${wholeText}${fraction ? "." + String(fraction).padStart(2, "0") : ""}`;
}
