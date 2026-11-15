import { mediaVerificationRoute } from "../../../../src/server/media-verification-route.ts";

const handlers = mediaVerificationRoute();
export const GET = handlers.GET;
export const POST = handlers.POST;
