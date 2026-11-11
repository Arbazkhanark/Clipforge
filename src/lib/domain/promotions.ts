import { getPlan, isPlanId } from "../billing/catalog.ts";

export function normalizePromotionCode(code: string): string {
  return code.trim().toUpperCase();
}

export function samePromotionDefinition(a: {
  id: string; type: string; status: string; code: string | null; discountType: string | null; discountValue: number | null; accessPlanId: string | null;
  durationDays: number | null; eligiblePlanIds: string[]; targetUserId: string | null; startsAt: Date; expiresAt: Date | null; usageLimit: number | null;
  createdByAdminId: string; reason: string | null; createdAt: Date; updatedAt: Date;
}, b: typeof a): boolean {
  return a.id === b.id && a.type === b.type && a.status === b.status && a.code === b.code && a.discountType === b.discountType && a.discountValue === b.discountValue &&
    a.accessPlanId === b.accessPlanId && a.durationDays === b.durationDays && a.eligiblePlanIds.length === b.eligiblePlanIds.length && a.eligiblePlanIds.every((id, index) => id === b.eligiblePlanIds[index]) &&
    a.targetUserId === b.targetUserId && a.startsAt.getTime() === b.startsAt.getTime() && (a.expiresAt?.getTime() ?? null) === (b.expiresAt?.getTime() ?? null) &&
    a.usageLimit === b.usageLimit && a.createdByAdminId === b.createdByAdminId && a.reason === b.reason && a.createdAt.getTime() === b.createdAt.getTime() && a.updatedAt.getTime() === b.updatedAt.getTime();
}

export function validPromotionRecord(p: {
  id: string; type: string; status: string; code: string | null; discountType: string | null; discountValue: number | null;
  accessPlanId: string | null; durationDays: number | null; eligiblePlanIds: string[]; targetUserId: string | null;
  startsAt: Date; expiresAt: Date | null; usageLimit: number | null; createdByAdminId: string; reason: string | null; createdAt: Date; updatedAt: Date;
}): boolean {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(p.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(p.createdByAdminId)) return false;
  if (!new Set(["draft", "active", "paused", "expired", "revoked"]).has(p.status)) return false;
  if (!Number.isFinite(p.startsAt.getTime()) || (p.expiresAt && (!Number.isFinite(p.expiresAt.getTime()) || p.expiresAt <= p.startsAt))) return false;
  if (p.usageLimit !== null && (!Number.isSafeInteger(p.usageLimit) || p.usageLimit < 1)) return false;
  if (p.reason !== null && p.reason.length > 500) return false;
  if (p.eligiblePlanIds.some((id) => !isPlanId(id) || id === "free")) return false;
  const access = p.type === "bonus_days" || p.type === "tier_access" || p.type === "free_access_coupon";
  const coupon = p.type === "discount_coupon" || p.type === "free_access_coupon";
  if (!access && p.type !== "discount_coupon") return false;
  if (access && (!p.accessPlanId || !isPlanId(p.accessPlanId) || p.accessPlanId === "free" || !Number.isSafeInteger(p.durationDays) || p.durationDays! < 1 || p.durationDays! > 30)) return false;
  if (p.type === "bonus_days" || p.type === "tier_access") {
    if (!p.targetUserId || p.code !== null || p.discountType !== null || p.discountValue !== null || p.eligiblePlanIds.length !== 0 || p.usageLimit !== null) return false;
  }
  if (coupon) {
    if (!p.code || p.code !== normalizePromotionCode(p.code) || !/^[A-Z0-9_-]{3,64}$/.test(p.code)) return false;
  }
  if (p.type === "discount_coupon") {
    if (p.discountType !== "percentage" && p.discountType !== "fixed_amount") return false;
    if (!Number.isSafeInteger(p.discountValue) || p.discountValue! < 1 || p.eligiblePlanIds.length === 0 || p.accessPlanId !== null || p.durationDays !== null) return false;
    if (p.discountType === "percentage" && p.discountValue! > 50) return false;
    if (p.discountType === "fixed_amount" && p.discountValue! <= 0) return false;
  }
  if (p.type === "free_access_coupon" && (p.discountType !== null || p.discountValue !== null || p.eligiblePlanIds.length !== 0)) return false;
  return true;
}

export function validDiscountSnapshot(p: {
  type: string; status: string; code: string | null; discountType: string | null; discountValue: number | null;
  eligiblePlanIds: string[]; targetUserId: string | null; startsAt: Date; expiresAt: Date | null; usageLimit: number | null;
}, input: { userId: string; planId: string; interval: string; listPricePaise: number; discountPaise: number; payablePaise: number; now: Date }): boolean {
  if (p.type !== "discount_coupon" || p.status !== "active" || p.startsAt > input.now || (p.expiresAt && p.expiresAt <= input.now)) return false;
  if (p.targetUserId && p.targetUserId !== input.userId) return false;
  if (!p.eligiblePlanIds.includes(input.planId) || !isPlanId(input.planId) || input.planId === "free") return false;
  if (input.interval !== "weekly" && input.interval !== "monthly") return false;
  const price = getPlan(input.planId).pricePaise[input.interval];
  if (input.listPricePaise !== price || !Number.isSafeInteger(input.discountPaise) || input.discountPaise < 1) return false;
  if (input.discountPaise > Math.floor(price / 2) || input.payablePaise !== price - input.discountPaise || input.payablePaise < 1) return false;
  if (p.discountType === "percentage") return Number.isSafeInteger(p.discountValue) && p.discountValue! <= 50 && input.discountPaise === Math.floor(price * p.discountValue! / 100);
  return p.discountType === "fixed_amount" && input.discountPaise === p.discountValue;
}

/** Derive the payable snapshot from catalog prices and stored coupon terms. This does not
 * establish that the coupon is redeemable; callers must separately validate its current
 * status, validity window, target, eligibility, and usage while holding the promotion lock. */
export function calculateDiscountAmounts(p: {
  type: string; discountType: string | null; discountValue: number | null;
}, input: { planId: string; interval: string }): { listPricePaise: number; discountPaise: number; payablePaise: number } | null {
  if (!isPlanId(input.planId) || input.planId === "free" || (input.interval !== "weekly" && input.interval !== "monthly")) return null;
  if (p.type !== "discount_coupon" || !Number.isSafeInteger(p.discountValue) || p.discountValue === null || p.discountValue < 1) return null;
  const listPricePaise = getPlan(input.planId).pricePaise[input.interval];
  const discountPaise = p.discountType === "percentage"
    ? p.discountValue <= 50 ? Math.floor(listPricePaise * p.discountValue / 100) : 0
    : p.discountType === "fixed_amount" ? p.discountValue : 0;
  const payablePaise = listPricePaise - discountPaise;
  if (!Number.isSafeInteger(discountPaise) || discountPaise < 1 || discountPaise > Math.floor(listPricePaise / 2) || !Number.isSafeInteger(payablePaise) || payablePaise < 1) return null;
  return { listPricePaise, discountPaise, payablePaise };
}

export function validPromotionEventMetadata(value: Record<string, unknown> | null | undefined): Record<string, string | number | boolean | null> | null {
  if (!value) return null;
  const allowed = new Set(["reason", "reasonOld", "reasonNew", "planId", "durationDays", "discountType", "discountValue", "discountPaise", "payablePaise", "status", "source"]);
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) return null;
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") return null;
    if (typeof item === "string" && item.length > 500) return null;
    if (typeof item === "number" && !Number.isFinite(item)) return null;
    result[key] = item as string | number | boolean | null;
  }
  return result;
}

export function promotionRedemptionTransitionAllowed(from: string, to: string): boolean {
  return (from === "reserved" && ["redeemed", "released", "manual_review"].includes(to)) ||
    (from === "manual_review" && ["redeemed", "released"].includes(to));
}
