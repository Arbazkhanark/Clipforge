import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryPagination, OffersHistoryDetail, OffersListState } from "../src/components/admin/AdminOffersClient.tsx";
import AdminOffersPage from "../app/admin/(protected)/offers/page.tsx";
import { setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
afterEach(() => setRuntimeForTests(null));

type UiElement = { type: unknown; props: Record<string, unknown> };
function isUiElement(value: unknown): value is UiElement { return typeof value === "object" && value !== null && "type" in value && "props" in value; }
function hasText(value: unknown, text: string): boolean {
  if (value === text) return true;
  if (Array.isArray(value)) return value.some((child) => hasText(child, text));
  return isUiElement(value) && hasText(value.props["children"], text);
}
function findButton(node: unknown, label: string): UiElement | null {
  for (const child of Array.isArray(node) ? node : [node]) {
    if (!isUiElement(child)) continue;
    if (child.type === "button" && hasText(child.props["children"], label)) return child;
    const nested = findButton(child.props["children"], label);
    if (nested) return nested;
  }
  return null;
}

const detailCoupon = {
  id: "coupon-1", type: "discount_coupon" as const, status: "active" as const, code: "SAVE20", discountType: "percentage" as const,
  discountValue: 20, discountValueUnit: "percentage_points", accessPlanId: null, durationDays: null, eligiblePlanIds: ["creator"], targetUserId: null,
  startsAt: "2026-11-08T12:00:00.000Z", expiresAt: null, usageLimit: 10, createdByAdminId: "admin-id", reason: null,
  createdAt: "2026-11-08T12:00:00.000Z", updatedAt: "2026-11-08T12:00:00.000Z",
  usage: { reserved: 2, redeemed: 3, released: 1, manualReview: 1, countsTowardUsageLimit: 6, usageLimit: 10, remainingSlots: 4 },
};
const redemptionPage = (page = 1) => ({ data: [{ id: "redemption-1", status: "redeemed", userDisplayIdentifier: "user-1", planId: "creator", interval: "weekly", listPricePaise: 49_900, discountPaise: 9_980, payablePaise: 39_920, currency: "INR", createdAt: detailCoupon.createdAt, updatedAt: detailCoupon.updatedAt }], page, pageSize: 1, total: 2 });
const lifecyclePage = (page = 1) => ({ data: [{ id: "event-1", eventType: "coupon_redeemed", subjectUserId: "user-1", actorUserId: "admin-id", redemptionId: "redemption-1", accessGrantId: null, occurredAt: detailCoupon.createdAt, outcome: "confirmed", auditUrl: "/admin/audit/audit-1" }], page, pageSize: 1, total: 2 });

test("Admin Offers list has honest loading, empty, and retryable error states", () => {
  const base = { coupons: [], retry: () => {}, onOpen: () => {}, onEdit: () => {}, onPage: () => {}, page: null };
  assert.match(html(<OffersListState {...base} loading={true} error="" />), /Loading coupon offers/);
  assert.match(html(<OffersListState {...base} loading={false} error="" />), /No coupons match these filters/);
  const failure = html(<OffersListState {...base} loading={false} error="unavailable" />);
  assert.match(failure, /Offers could not be loaded/);
  assert.match(failure, />Retry</);
});

test("Admin Offers shows stored usage counts and no available actions for paused coupons", () => {
  const coupon = {
    id: "coupon-1", type: "discount_coupon" as const, status: "paused" as const, code: "SAVE50", discountType: "percentage" as const,
    discountValue: 50, discountValueUnit: "percentage_points", accessPlanId: null, durationDays: null, eligiblePlanIds: ["creator"],
    targetUserId: null, startsAt: "2026-11-08T12:00:00.000Z", expiresAt: null, usageLimit: 10, createdByAdminId: "admin-id", reason: null,
    createdAt: "2026-11-08T12:00:00.000Z", updatedAt: "2026-11-08T12:00:00.000Z",
    usage: { reserved: 1, redeemed: 2, released: 1, manualReview: 1, countsTowardUsageLimit: 4, usageLimit: 10, remainingSlots: 6 },
  };
  const output = html(<OffersListState loading={false} error="" coupons={[coupon]} retry={() => {}} onOpen={() => {}} onEdit={() => {}} onPage={() => {}} page={{ data: [coupon], page: 1, pageSize: 25, total: 1 }} />);
  assert.match(output, /SAVE50/);
  assert.match(output, /Reserved 1 · Redeemed 2/);
  assert.match(output, /Released 1 · Manual review 1/);
  assert.doesNotMatch(output, /Activate|Pause/);
});

test("Offers detail renders status-separated usage summary and redemption history pagination", () => {
  const detail = <OffersHistoryDetail coupon={detailCoupon} redemptions={redemptionPage()} lifecycle={lifecyclePage()} loading={false} error="" onRetry={() => {}} onRedemptionPage={() => {}} onLifecyclePage={() => {}} />;
  const output = html(detail);
  for (const text of ["Reserved", "2", "Redeemed", "3", "Released", "1", "Manual review", "6", "Slots remaining", "4"]) assert.match(output, new RegExp(text));
  assert.match(output, /user-1/);
  assert.match(output, /INR 499\.00/);
  assert.match(output, /INR 99\.80/);
  assert.match(output, /INR 399\.20/);
  assert.match(output, /Redemption history pages/);
  assert.match(output, /Page 1/);
  assert.match(output, />Next</);

  let requestedPage = 0;
  const pagination = HistoryPagination({ page: redemptionPage(), label: "Redemption", onPage: (next) => { requestedPage = next; } });
  const next = findButton(pagination, "Next");
  const nextClick = next?.props["onClick"];
  assert.equal(typeof nextClick, "function");
  (nextClick as () => void)();
  assert.equal(requestedPage, 2);
  assert.equal(findButton(pagination, "Previous")?.props.disabled, true);
});

test("Offers detail renders lifecycle pagination and only links an available audit record", () => {
  const detail = <OffersHistoryDetail coupon={detailCoupon} redemptions={redemptionPage()} lifecycle={lifecyclePage()} loading={false} error="" onRetry={() => {}} onRedemptionPage={() => {}} onLifecyclePage={() => {}} />;
  const output = html(detail);
  assert.match(output, /Lifecycle history/);
  assert.match(output, /Lifecycle history pages/);
  assert.match(output, /coupon redeemed/);
  assert.match(output, /href="\/admin\/audit\/audit-1"/);
  let requestedPage = 0;
  const pagination = HistoryPagination({ page: lifecyclePage(), label: "Lifecycle", onPage: (next) => { requestedPage = next; } });
  const lifecycleNextClick = findButton(pagination, "Next")?.props["onClick"];
  assert.equal(typeof lifecycleNextClick, "function");
  (lifecycleNextClick as () => void)();
  assert.equal(requestedPage, 2);
  const noAudit = html(<OffersHistoryDetail coupon={detailCoupon} redemptions={redemptionPage()} lifecycle={{ ...lifecyclePage(), data: [{ ...lifecyclePage().data[0]!, auditUrl: null }] }} loading={false} error="" onRetry={() => {}} onRedemptionPage={() => {}} onLifecyclePage={() => {}} />);
  assert.match(noAudit, /Unavailable/);
  assert.doesNotMatch(noAudit, /href="\/admin\/audit/);
});

test("Offers detail has history loading, empty, error and wired retry states", () => {
  const base = { coupon: detailCoupon, redemptions: null, lifecycle: null, error: "", onRetry: () => {}, onRedemptionPage: () => {}, onLifecyclePage: () => {} };
  const loading = html(<OffersHistoryDetail {...base} loading={true} />);
  assert.match(loading, /Loading redemption and lifecycle history/);
  assert.match(loading, /Loading lifecycle history/);
  const empty = html(<OffersHistoryDetail {...base} redemptions={{ data: [], page: 1, pageSize: 25, total: 0 }} lifecycle={{ data: [], page: 1, pageSize: 25, total: 0 }} loading={false} />);
  assert.match(empty, /No redemptions are recorded/);
  assert.match(empty, /No lifecycle events are recorded/);

  let retried = false;
  const failure = <OffersHistoryDetail {...base} loading={false} error="History unavailable" onRetry={() => { retried = true; }} />;
  const failureHtml = html(failure);
  assert.match(failureHtml, /History unavailable/);
  assert.match(failureHtml, />Retry history</);
  const errorElement = OffersHistoryDetail({ ...base, loading: false, error: "History unavailable", onRetry: () => { retried = true; } });
  const retry = findButton(errorElement, "Retry history");
  const retryClick = retry?.props["onClick"];
  assert.equal(typeof retryClick, "function");
  (retryClick as () => void)();
  assert.equal(retried, true);
});

test("Offers page enforces the Admin page boundary and renders inside the Admin shell", async () => {
  const runtime = (role: "admin" | "user" | null): Runtime => ({
    mode: "local", repo: {} as Runtime["repo"], currentUserId: async () => null,
    currentPrincipal: async () => role ? { userId: `${role}-id`, role } : null,
    newId: () => "unused", now: () => new Date("2026-11-08T12:00:00.000Z"),
  });
  setRuntimeForTests(runtime(null));
  await assert.rejects(AdminOffersPage(), (error: unknown) => (error as { digest?: string }).digest?.includes("307"));
  setRuntimeForTests(runtime("user"));
  await assert.rejects(AdminOffersPage(), (error: unknown) => (error as { digest?: string }).digest?.endsWith(";404"));
  setRuntimeForTests(runtime("admin"));
  const output = html(await AdminOffersPage());
  assert.match(output, /Offers/);
  assert.match(output, /Coupon controls only/);
  assert.match(output, /Usage totals are based on persisted redemption statuses/);
  assert.doesNotMatch(output, /Usage totals, redemption history and lifecycle history are not included/);
  assert.match(output, /Live data not connected/);
});
