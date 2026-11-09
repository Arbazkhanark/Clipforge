import { createAdminPromotionDetailRoute, createAdminPromotionStatusRoute, createAdminPromotionUpdateRoute } from "../../../../../src/server/admin/promotion-routes.ts";

export const GET = createAdminPromotionDetailRoute();
export const PUT = createAdminPromotionUpdateRoute();
export const PATCH = createAdminPromotionStatusRoute();
