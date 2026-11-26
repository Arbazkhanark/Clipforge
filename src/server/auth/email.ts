import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { AppError } from "../errors.ts";
import type { Environment } from "../environment.ts";

export interface EmailMessage { to: string; subject: string; text: string; html?: string; }
export interface EmailSender { send(message: EmailMessage): Promise<void>; }
export type EmailProvider = "ses" | "nodemailer" | "outbox" | "unavailable";
export type EmailConfigurationError = "provider_unknown" | "ses_credentials_missing" | "smtp_configuration_invalid" | "provider_dependency_missing" | "provider_environment_mismatch" | "staging_recipient_allowlist_invalid";

/** Used when no provider is selected. It never stores or pretends to send a message. */
export class UnavailableEmailSender implements EmailSender {
  constructor(private readonly code: "email_not_configured" | "email_configuration_invalid" = "email_not_configured") {}
  async send(_message: EmailMessage): Promise<void> {
    throw new AppError(503, this.code, this.code === "email_configuration_invalid" ? "Email provider configuration is invalid. No message was sent." : "Email delivery is not configured. No message was sent.");
  }
}

export interface EmailSetup {
  sender: EmailSender;
  delivery: EmailProvider;
  provider: EmailProvider;
  /** True only when selected email flow requires a real one-time verification. */
  requireVerifiedEmail: boolean;
  configurationError?: EmailConfigurationError;
  outbox?: MemoryEmailOutbox;
}

/**
 * Runtime-safe provider wrapper. Merely constructing a runtime must not validate SES
 * configuration or initialize its credential chain; that work starts on the first
 * explicitly enabled email operation.
 */
export function createLazyEmailSetup(env: Environment, enabled: boolean, dependencies: EmailSetupDependencies = {}): EmailSetup {
  if (enabled && isEnabledFakeProvider(env)) return fakeEmailSetup();
  let setup: EmailSetup | undefined;
  const sender: EmailSender = {
    async send(message) {
      if (!enabled) {
        await new UnavailableEmailSender().send(message);
        return;
      }
      try {
        setup ??= createEmailSetup(env, dependencies);
        await setup.sender.send(message);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(503, "email_configuration_invalid", "Email provider configuration is invalid. No message was sent.");
      }
    },
  };
  return { sender, delivery: "unavailable", provider: "unavailable", requireVerifiedEmail: enabled };
}

function isEnabledFakeProvider(env: Environment): boolean {
  const deployment = emailDeployment(env);
  const primary = normalizeEmailProvider(env["EMAIL_PROVIDER"]);
  const legacy = normalizeEmailProvider(env["CLIPFORGE_EMAIL_PROVIDER"]);
  if (primary.invalid || legacy.invalid || (primary.value && legacy.value && primary.value !== legacy.value)) return false;
  const choice = primary.value ?? legacy.value;
  const fakeAllowed = deployment === "test" || deployment === "development" || deployment === "staging" || deployment === "preview";
  return fakeAllowed && (choice === "fake" || (!choice && (deployment === "test" || deployment === "staging" || deployment === "preview")));
}

export interface SmtpTransport {
  sendMail(message: EmailMessage & { from: string }): Promise<unknown>;
}
export type SmtpTransportFactory = (options: Record<string, unknown>) => SmtpTransport;
export type FetchEmail = typeof fetch;
export interface EmailSetupDependencies {
  createSmtpTransport?: SmtpTransportFactory;
  fetch?: FetchEmail;
  now?: () => Date;
  /** Injected for deterministic tests or a caller-managed AWS credential provider. */
  resolveAwsCredentials?: () => Promise<SesSigningCredentials>;
}

export interface SesSigningCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string; }

class AllowlistedEmailSender implements EmailSender {
  private readonly allowed: Set<string>;
  constructor(private readonly sender: EmailSender, addresses: Set<string>) { this.allowed = addresses; }
  async send(message: EmailMessage): Promise<void> {
    if (!this.allowed.has(message.to.trim().toLowerCase())) {
      throw new AppError(503, "email_delivery_failed", "Email delivery failed. No verification was confirmed.");
    }
    await this.sender.send(message);
  }
}

/** Provider setup is server-only. Environment and provider mismatches always fail closed. */
export function createEmailSetup(env: Environment = process.env, dependencies: EmailSetupDependencies = {}): EmailSetup {
  const deployment = emailDeployment(env);
  const primary = normalizeEmailProvider(env["EMAIL_PROVIDER"]);
  const legacy = normalizeEmailProvider(env["CLIPFORGE_EMAIL_PROVIDER"]);
  if (primary.invalid || legacy.invalid || (primary.value && legacy.value && primary.value !== legacy.value)) {
    return rejectEmailSetup(deployment, "provider_environment_mismatch", env);
  }
  const choice = primary.value ?? legacy.value;

  if (deployment === "test") {
    if (choice && choice !== "fake") return invalidSetup("provider_environment_mismatch");
    return fakeEmailSetup();
  }
  if (deployment === "production") {
    if (choice !== "ses") return rejectEmailSetup(deployment, choice ? "provider_environment_mismatch" : "provider_unknown", env);
    if (hasStaticAwsCredentials(env)) return rejectEmailSetup(deployment, "ses_credentials_missing", env);
    const setup = createSesSetup(env, dependencies);
    if (setup.delivery !== "ses") throw new Error("Email provider configuration is invalid.");
    return setup;
  }
  if (deployment === "staging" || deployment === "preview") {
    if (!choice || choice === "fake") return fakeEmailSetup();
    if (choice !== "ses") return invalidSetup("provider_environment_mismatch");
    const allowlist = readRecipientAllowlist(env["CLIPFORGE_EMAIL_RECIPIENT_ALLOWLIST"]);
    if (!allowlist) return invalidSetup("staging_recipient_allowlist_invalid");
    const ses = createSesSetup(env, dependencies);
    if (ses.delivery !== "ses") return ses;
    return { ...ses, sender: new AllowlistedEmailSender(ses.sender, allowlist) };
  }
  if (deployment === "development") {
    if (choice === "ses") return invalidSetup("provider_environment_mismatch");
    if (!choice) return { sender: new UnavailableEmailSender(), delivery: "unavailable", provider: "unavailable", requireVerifiedEmail: false };
    if (choice === "fake") return fakeEmailSetup();
    if (choice !== "nodemailer") return invalidSetup("provider_environment_mismatch");
    return createSmtpSetup(env, dependencies);
  }
  return rejectEmailSetup(deployment, "provider_environment_mismatch", env);
}

function emailDeployment(env: Environment): "development" | "test" | "preview" | "staging" | "production" | null {
  const value = (env["CLIPFORGE_DEPLOYMENT_ENV"] ?? env["NODE_ENV"] ?? "").trim().toLowerCase();
  if (!["development", "test", "preview", "staging", "production"].includes(value)) return null;
  const node = env["NODE_ENV"]?.trim().toLowerCase();
  if ((value === "development" && node && node !== "development") || (value === "test" && node && node !== "test") || (["preview", "staging", "production"].includes(value) && node && node !== "production")) return null;
  return value as "development" | "test" | "preview" | "staging" | "production";
}

function normalizeEmailProvider(value: string | undefined): { value: "ses" | "nodemailer" | "fake" | null; invalid?: true } {
  if (value === undefined || !value.trim()) return { value: null };
  const normalized = value.trim().toLowerCase();
  if (normalized === "ses") return { value: "ses" };
  if (normalized === "nodemailer" || normalized === "smtp") return { value: "nodemailer" };
  if (normalized === "outbox" || normalized === "fake") return { value: "fake" };
  return { value: null, invalid: true };
}

function fakeEmailSetup(): EmailSetup {
  const outbox = new MemoryEmailOutbox();
  return { sender: outbox, delivery: "outbox", provider: "outbox", requireVerifiedEmail: true, outbox };
}

function rejectEmailSetup(deployment: ReturnType<typeof emailDeployment>, error: EmailConfigurationError, env: Environment): EmailSetup {
  if (deployment === "production" || env["NODE_ENV"] === "production") throw new Error("Email provider configuration is invalid.");
  return invalidSetup(error);
}

function hasStaticAwsCredentials(env: Environment): boolean {
  return Boolean(env["AWS_ACCESS_KEY_ID"]?.trim() || env["AWS_SECRET_ACCESS_KEY"]?.trim() || env["AWS_SESSION_TOKEN"]?.trim());
}

function readRecipientAllowlist(value: string | undefined): Set<string> | null {
  if (!value || value.length > 32_000) return null;
  const entries = value.split(",").map((entry) => entry.trim().toLowerCase());
  const mailbox = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
  if (!entries.length || entries.length > 500 || entries.some((entry) => entry.length > 320 || !mailbox.test(entry))) return null;
  return new Set(entries);
}

function createSesSetup(env: Environment, dependencies: EmailSetupDependencies): EmailSetup {
  const region = (env["AWS_REGION"] ?? "").trim();
  const accessKey = env["AWS_ACCESS_KEY_ID"]?.trim() ?? "";
  const secretKey = env["AWS_SECRET_ACCESS_KEY"] ?? "";
  const sessionToken = env["AWS_SESSION_TOKEN"]?.trim() ?? "";
  const from = validFrom(env["EMAIL_FROM"]);
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region) || !from || Boolean(accessKey) !== Boolean(secretKey.trim()) || (sessionToken && !accessKey)) {
    return invalidSetup("ses_credentials_missing");
  }
  const credentials = accessKey
    ? async () => ({ accessKeyId: accessKey, secretAccessKey: secretKey, ...(sessionToken ? { sessionToken } : {}) })
    : dependencies.resolveAwsCredentials ?? (async () => {
      const { defaultProvider } = await import("@aws-sdk/credential-provider-node");
      return defaultProvider()();
    });
  return { sender: new SesEmailSender(region, credentials, from, dependencies.fetch ?? fetch, dependencies.now ?? (() => new Date())), delivery: "ses", provider: "ses", requireVerifiedEmail: true };
}

function createSmtpSetup(env: Environment, dependencies: EmailSetupDependencies): EmailSetup {
  const host = (env["SMTP_HOST"] ?? "").trim();
  const port = Number(env["SMTP_PORT"]);
  const secureValue = (env["SMTP_SECURE"] ?? "").trim().toLowerCase();
  const secure = secureValue === "true" ? true : secureValue === "false" ? false : null;
  const user = env["SMTP_USER"] ?? "";
  const password = env["SMTP_PASS"] ?? "";
  const from = validFrom(env["EMAIL_FROM"]);
  if (!host || /[\s/@]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || secure === null || !user.trim() || !password || !from) return invalidSetup("smtp_configuration_invalid");
  try {
    const transport = (dependencies.createSmtpTransport ?? loadNodemailerTransport)({ host, port, secure, auth: { user, pass: password }, requireTLS: !secure, tls: { minVersion: "TLSv1.2" }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
    return { sender: new NodemailerEmailSender(transport, from), delivery: "nodemailer", provider: "nodemailer", requireVerifiedEmail: true };
  } catch { return invalidSetup("provider_dependency_missing"); }
}

function invalidSetup(configurationError: EmailConfigurationError): EmailSetup {
  return { sender: new UnavailableEmailSender("email_configuration_invalid"), delivery: "unavailable", provider: "unavailable", requireVerifiedEmail: true, configurationError };
}

function validFrom(value: string | undefined): string | null {
  if (!value || value.length > 320 || /[\r\n]/.test(value)) return null;
  const mailbox = /<([^<>]+)>/.exec(value)?.[1] ?? value;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(mailbox) ? value.trim() : null;
}

export class MemoryEmailOutbox implements EmailSender {
  messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> { this.messages.push(structuredClone(message)); }
}

export class NodemailerEmailSender implements EmailSender {
  constructor(private readonly transport: SmtpTransport, private readonly from: string) {}
  async send(message: EmailMessage): Promise<void> {
    try { await this.transport.sendMail({ ...message, from: this.from }); }
    catch { throw new AppError(503, "email_delivery_failed", "Email delivery failed. No verification was confirmed."); }
  }
}

export class SesEmailSender implements EmailSender {
  constructor(
    private readonly region: string,
    private readonly resolveCredentials: () => Promise<SesSigningCredentials>,
    private readonly from: string,
    private readonly sendRequest: FetchEmail = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(message: EmailMessage): Promise<void> {
    let resolved: SesSigningCredentials;
    try { resolved = await this.resolveCredentials(); }
    catch { throw new AppError(503, "email_delivery_failed", "Email delivery failed. No verification was confirmed."); }
    if (!resolved.accessKeyId || !resolved.secretAccessKey || (resolved.sessionToken !== undefined && !resolved.sessionToken)) {
      throw new AppError(503, "email_delivery_failed", "Email delivery failed. No verification was confirmed.");
    }
    const credentials = { region: this.region, accessKey: resolved.accessKeyId, secretKey: resolved.secretAccessKey, from: this.from, ...(resolved.sessionToken ? { sessionToken: resolved.sessionToken } : {}) };
    const host = `email.${credentials.region}.amazonaws.com`;
    const body = JSON.stringify({
      FromEmailAddress: credentials.from,
      Destination: { ToAddresses: [message.to] },
      Content: { Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: { Text: { Data: message.text, Charset: "UTF-8" }, ...(message.html ? { Html: { Data: message.html, Charset: "UTF-8" } } : {}) },
      } },
    });
    const payloadHash = sha256(body);
    const amzDate = this.now().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const path = "/v2/email/outbound-emails";
    const signedHeaders = credentials.sessionToken ? "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token" : "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n${credentials.sessionToken ? `x-amz-security-token:${credentials.sessionToken}\n` : ""}`;
    const canonicalRequest = ["POST", path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${credentials.region}/ses/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    const dateKey = hmac(`AWS4${credentials.secretKey}`, date);
    const regionKey = hmac(dateKey, credentials.region);
    const serviceKey = hmac(regionKey, "ses");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    let response: Response;
    try {
      response = await this.sendRequest(`https://${host}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}), authorization },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new AppError(503, "email_delivery_failed", "Email delivery failed. No verification was confirmed."); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError(503, "email_delivery_failed", "Email delivery failed. No verification was confirmed.");
    }
    await response.body?.cancel().catch(() => undefined);
  }
}

function loadNodemailerTransport(options: Record<string, unknown>): SmtpTransport {
  const nodemailer = createRequire(import.meta.url)("nodemailer") as { createTransport(config: Record<string, unknown>): SmtpTransport };
  return nodemailer.createTransport(options);
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: string | Uint8Array, value: string): Buffer => createHmac("sha256", key).update(value, "utf8").digest();

/** The link opens a confirmation page; only its explicit POST consumes the token. */
export const verificationEmail = (to: string, baseUrl: string, token: string): EmailMessage => ({
  to, subject: "Confirm your ClipForge email",
  text: `ClipForge\n\nConfirm your email by opening this link and pressing Confirm (valid for 24 hours):\n${baseUrl}/verify-email?token=${token}\n\nIf you did not create an account, ignore this message.`,
});

export const passwordResetEmail = (to: string, baseUrl: string, token: string): EmailMessage => ({
  to, subject: "Reset your ClipForge password",
  text: `ClipForge\n\nOpen this link to choose a new password (valid for 1 hour):\n${baseUrl}/reset-password?token=${token}\n\nIf you did not ask for this, ignore this message; your password has not changed.`,
});

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
