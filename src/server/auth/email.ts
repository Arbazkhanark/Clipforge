import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { AppError } from "../errors.ts";
import type { Environment } from "../environment.ts";

export interface EmailMessage { to: string; subject: string; text: string; html?: string; }
export interface EmailSender { send(message: EmailMessage): Promise<void>; }
export type EmailProvider = "ses" | "nodemailer" | "outbox" | "unavailable";
export type EmailConfigurationError = "provider_unknown" | "ses_credentials_missing" | "smtp_configuration_invalid" | "provider_dependency_missing";

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

export interface SmtpTransport {
  sendMail(message: EmailMessage & { from: string }): Promise<unknown>;
}
export type SmtpTransportFactory = (options: Record<string, unknown>) => SmtpTransport;
export type FetchEmail = typeof fetch;
export interface EmailSetupDependencies {
  createSmtpTransport?: SmtpTransportFactory;
  fetch?: FetchEmail;
  now?: () => Date;
}

/** Provider setup is server-only. Only the selected adapter is initialized; configuration values are never returned. */
export function createEmailSetup(env: Environment = process.env, dependencies: EmailSetupDependencies = {}): EmailSetup {
  const choice = (env["EMAIL_PROVIDER"] ?? "").trim().toLowerCase();
  if (choice === "ses") {
    const region = (env["AWS_REGION"] ?? "").trim();
    const accessKey = env["AWS_ACCESS_KEY_ID"] ?? "";
    const secretKey = env["AWS_SECRET_ACCESS_KEY"] ?? "";
    const from = validFrom(env["EMAIL_FROM"]);
    if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region) || !accessKey.trim() || !secretKey.trim() || !from) {
      return invalidSetup("ses_credentials_missing");
    }
    return { sender: new SesEmailSender(region, accessKey, secretKey, from, dependencies.fetch ?? fetch, dependencies.now ?? (() => new Date())), delivery: "ses", provider: "ses", requireVerifiedEmail: true };
  }
  if (choice === "nodemailer") {
    const host = (env["SMTP_HOST"] ?? "").trim();
    const port = Number(env["SMTP_PORT"]);
    const secureValue = (env["SMTP_SECURE"] ?? "").trim().toLowerCase();
    const secure = secureValue === "true" ? true : secureValue === "false" ? false : null;
    const user = env["SMTP_USER"] ?? "";
    const password = env["SMTP_PASS"] ?? "";
    const from = validFrom(env["EMAIL_FROM"]);
    if (!host || /[\s/@]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || secure === null || !user.trim() || !password || !from) {
      return invalidSetup("smtp_configuration_invalid");
    }
    try {
      const transport = (dependencies.createSmtpTransport ?? loadNodemailerTransport)({
        host, port, secure, auth: { user, pass: password },
        requireTLS: !secure,
        tls: { minVersion: "TLSv1.2" },
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      });
      return { sender: new NodemailerEmailSender(transport, from), delivery: "nodemailer", provider: "nodemailer", requireVerifiedEmail: true };
    } catch {
      return invalidSetup("provider_dependency_missing");
    }
  }

  // Keep the existing local memory outbox available for development/test workflows only.
  const legacyChoice = (env["CLIPFORGE_EMAIL_PROVIDER"] ?? "").trim().toLowerCase();
  if (!choice && legacyChoice === "outbox" && env["NODE_ENV"] !== "production") {
    const outbox = new MemoryEmailOutbox();
    return { sender: outbox, delivery: "outbox", provider: "outbox", requireVerifiedEmail: true, outbox };
  }
  if (choice) return invalidSetup("provider_unknown");
  return { sender: new UnavailableEmailSender(), delivery: "unavailable", provider: "unavailable", requireVerifiedEmail: false };
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

interface SesEmailCredentials { region: string; accessKey: string; secretKey: string; from: string; }
export class SesEmailSender implements EmailSender {
  constructor(
    private readonly region: string,
    private readonly accessKey: string,
    private readonly secretKey: string,
    private readonly from: string,
    private readonly sendRequest: FetchEmail = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const credentials: SesEmailCredentials = { region: this.region, accessKey: this.accessKey, secretKey: this.secretKey, from: this.from };
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
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
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
        headers: { "content-type": "application/json", "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, authorization },
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
