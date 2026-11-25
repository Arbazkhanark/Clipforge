import { PLAN_CATALOG, PLAN_IDS, formatPaiseAsRupees } from "../../lib/billing/catalog.ts";
import { readGoogleOAuthConfig } from "../auth/google-oauth.ts";
import { readInstagramOAuthConfig } from "../instagram/instagram-oauth.ts";
import { readRazorpayTestConfig } from "../billing/razorpay-client.ts";
import { createConfiguredTemporaryMediaAccessAdapter } from "../storage/temporary-media-access.ts";
import { readMediaStorageConfiguration } from "../storage/storage-config.ts";
import type { Environment } from "../environment.ts";

export type PlatformSettingState = "configured" | "incomplete" | "missing" | "application_default" | "not_implemented";
export interface PlatformSetting {
  label: string;
  state: PlatformSettingState;
  summary: string;
  details: string[];
  liveVerified: false;
}
export interface PlatformSettingGroup { title: string; items: PlatformSetting[]; }
export interface AdminPlatformSettings {
  environment: string;
  runtimeMode: string;
  groups: PlatformSettingGroup[];
  plans: Array<{ id: string; name: string; weekly: string; monthly: string; connectedAccounts: number; storageGiB: number; activeCampaigns: number }>;
}

const present = (env: Environment, keys: string[]): number => keys.filter((key) => (env[key] ?? "").trim().length > 0).length;
const stateForPresence = (count: number, required: number): PlatformSettingState => count === 0 ? "missing" : count === required ? "configured" : "incomplete";
const item = (label: string, state: PlatformSettingState, summary: string, details: string[] = []): PlatformSetting => ({ label, state, summary, details, liveVerified: false });

function runtimeMode(env: Environment): string {
  if (env["CLIPFORGE_LOCAL_AUTH"] === "true" && env["NODE_ENV"] !== "production") return "Local in-memory authentication";
  if ((env["DATABASE_URL"] ?? "").trim()) return "Database mode configured (connection not checked)";
  if (env["CLIPFORGE_DEMO_MODE"] === "true") return "Demo mode";
  return "Unconfigured mode";
}

/** Builds a redacted, read-only snapshot. Environment values are only tested for presence/validity and never returned. */
export function buildAdminPlatformSettings(env: Environment = process.env): AdminPlatformSettings {
  const googleKeys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI"];
  const instagramKeys = ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "INSTAGRAM_OAUTH_REDIRECT_URI", "INSTAGRAM_TOKEN_KEY"];
  const razorpayKeys = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"];
  const googleState = present(env, googleKeys) === 0 ? "missing" : readGoogleOAuthConfig(env) ? "configured" : "incomplete";
  const instagramState = present(env, instagramKeys) === 0 ? "missing" : readInstagramOAuthConfig(env) ? "configured" : "incomplete";
  const razorpay = readRazorpayTestConfig(env);
  const razorpayState = present(env, razorpayKeys) === 0 ? "missing" : razorpay ? "configured" : "incomplete";
  const subscriptionPlanKeys = PLAN_IDS.filter((id) => id !== "free").flatMap((id) => [
    `RAZORPAY_PLAN_${id.toUpperCase()}_WEEKLY`, `RAZORPAY_PLAN_${id.toUpperCase()}_MONTHLY`,
  ]);
  const planIdCount = present(env, subscriptionPlanKeys);
  const emailProvider = (env["EMAIL_PROVIDER"] ?? env["CLIPFORGE_EMAIL_PROVIDER"] ?? "").trim().toLowerCase();
  const sesKeys = ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "EMAIL_FROM"];
  const smtpKeys = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM"];
  const emailKeys = emailProvider === "ses" ? sesKeys : emailProvider === "nodemailer" ? smtpKeys : [];
  const emailCount = present(env, emailKeys);
  const emailState: PlatformSettingState = emailProvider === "outbox" && env["NODE_ENV"] !== "production"
    ? "configured"
    : emailProvider === "ses" || emailProvider === "nodemailer"
      ? emailCount === emailKeys.length ? "configured" : "incomplete"
      : emailProvider ? "incomplete" : "missing";
  const publishingEnabled = env["CLIPFORGE_PUBLISHING_ENABLED"] === "true" && env["CLIPFORGE_PUBLISHING_LIVE_APPROVED"] === "true";
  const tokenSigningReady = createConfiguredTemporaryMediaAccessAdapter(env) !== null;
  const mediaOriginPresent = present(env, ["CLIPFORGE_PUBLIC_MEDIA_ORIGIN", "CLIPFORGE_TEMP_MEDIA_SIGNING_KEY"]);
  const storageConfiguration = readMediaStorageConfiguration(env);
  const storageState: PlatformSettingState = storageConfiguration.ok
    ? storageConfiguration.provider === "s3" ? "configured" : "incomplete"
    : present(env, ["CLIPFORGE_STORAGE_PROVIDER", "CLIPFORGE_S3_DEVELOPMENT_BUCKET", "CLIPFORGE_S3_STAGING_BUCKET", "CLIPFORGE_S3_PRODUCTION_BUCKET", "CLIPFORGE_S3_REGION", "CLIPFORGE_S3_ACCESS_KEY_ID", "CLIPFORGE_S3_SECRET_ACCESS_KEY"]) === 0 ? "missing" : "incomplete";

  return {
    environment: ["development", "preview", "test", "staging", "production"].includes((env["CLIPFORGE_DEPLOYMENT_ENV"] ?? env["NODE_ENV"]) ?? "")
      ? (env["CLIPFORGE_DEPLOYMENT_ENV"] ?? env["NODE_ENV"]) as string
      : "Unknown",
    runtimeMode: runtimeMode(env),
    groups: [
      { title: "Application", items: [
        item("Runtime mode", "application_default", runtimeMode(env), ["Mode is inferred from runtime flags. No database identity or connection is checked."]),
        item("Base URL", (env["CLIPFORGE_BASE_URL"] ?? "").trim() ? "configured" : "application_default", (env["CLIPFORGE_BASE_URL"] ?? "").trim() ? "A base URL is configured; its value is hidden." : "The application default is used; the configured URL is not shown."),
        item("Persisted platform settings", "not_implemented", "No editable platform-settings record is stored; this page reports server configuration and code defaults only."),
      ] },
      { title: "Authentication & security", items: [
        item("Password and session policy", "application_default", "Application defaults are active.", ["Password hashing uses Node.js scrypt. Sessions have HttpOnly, SameSite cookies; Secure is used for HTTPS and production.", "Session lifetime and idle limits are application constants; no secret values are displayed."]),
        item("Request rate limiting", "application_default", "In-memory rate limiting is implemented.", ["Counters reset on restart and are not shared across multiple application processes."]),
        item("Google sign-in configuration", googleState, googleState === "configured" ? "Configuration passed local shape checks; provider connectivity was not tested." : "Google sign-in is missing or incomplete."),
      ] },
      { title: "Instagram / Meta", items: [
        item("Instagram OAuth configuration", instagramState, instagramState === "configured" ? "Configuration passed local checks; no Meta API or OAuth request was made." : "Instagram OAuth configuration is missing or incomplete."),
        item("Pinned Graph API version", present(env, ["INSTAGRAM_GRAPH_API_VERSION"]) === 1 ? "configured" : "missing", present(env, ["INSTAGRAM_GRAPH_API_VERSION"]) === 1 ? "A version value is present; its provider support was not verified." : "The publishing worker requires an explicitly pinned API version."),
        item("Instagram publishing worker", publishingEnabled ? "configured" : "missing", publishingEnabled ? "Both explicit opt-in gates are set; this does not prove a worker is running or publishing is healthy." : "Live worker opt-in is not fully configured; worker remains disabled."),
        item("Public media access", tokenSigningReady ? "configured" : mediaOriginPresent > 0 ? "incomplete" : "missing", tokenSigningReady ? "HTTPS temporary-media configuration passed local checks; reachability was not tested." : "HTTPS temporary-media access is missing or incomplete."),
      ] },
      { title: "Razorpay", items: [
        item("Sandbox checkout configuration", razorpayState, razorpayState === "configured" ? "Local configuration is accepted only for test-mode credentials; no provider request was made." : "Test-mode credentials are missing or incomplete. Live checkout is not enabled by this view."),
        item("Recurring provider plans", stateForPresence(planIdCount, subscriptionPlanKeys.length), `${planIdCount} of ${subscriptionPlanKeys.length} expected plan identifiers are present; values are hidden. Provider plans were not verified.`),
        item("Webhook verification secret", present(env, ["RAZORPAY_WEBHOOK_SECRET"]) === 1 ? "configured" : "missing", present(env, ["RAZORPAY_WEBHOOK_SECRET"]) === 1 ? "A webhook secret is present; webhook delivery was not tested." : "Webhook secret is not configured."),
      ] },
      { title: "Storage & media processing", items: [
        item("Private S3 media storage", storageState, storageConfiguration.ok && storageConfiguration.provider === "s3"
          ? `S3 configuration passed local validation for the ${storageConfiguration.environment} environment; connectivity was not tested.`
          : storageConfiguration.ok ? "Local disk is only suitable for explicit development/test fallback." : "Private S3 storage is missing or incomplete; uploads fail closed."),
        item("FFmpeg / FFprobe", "application_default", "External executables are required for media inspection and rendering; availability was not checked here."),
      ] },
      { title: "Email & background jobs", items: [
        item("Email delivery", emailState, emailProvider === "outbox" && env["NODE_ENV"] !== "production" ? "Local messages use an in-memory outbox; no email is sent." : emailProvider === "ses" && emailState === "configured" ? "SES configuration fields are present; sending was not tested." : emailProvider === "nodemailer" && emailState === "configured" ? "SMTP configuration fields are present; sending was not tested." : "Email delivery is unavailable or incompletely configured."),
        item("Automatic background scheduling", "not_implemented", "Worker entry points are explicit commands; no application scheduler starts them automatically."),
      ] },
    ],
    plans: PLAN_IDS.map((id) => {
      const plan = PLAN_CATALOG[id];
      return { id, name: plan.name, weekly: formatPaiseAsRupees(plan.pricePaise.weekly), monthly: formatPaiseAsRupees(plan.pricePaise.monthly), connectedAccounts: plan.limits.connectedAccounts, storageGiB: plan.limits.storageBytes / (1024 ** 3), activeCampaigns: plan.limits.activeCampaigns };
    }),
  };
}
