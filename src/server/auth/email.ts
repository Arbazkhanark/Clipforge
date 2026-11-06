// Email goes through an interface. No provider is configured, so nothing is ever really sent: the dev adapter
// keeps messages in a memory "outbox". Do not claim email delivery works until a provider is configured and tested.
import { AppError } from "../errors.ts";

export interface EmailMessage { to: string; subject: string; text: string; }
export interface EmailSender { send(message: EmailMessage): Promise<void>; }

/** Used when no provider is selected. It never stores or pretends to send a message. */
export class UnavailableEmailSender implements EmailSender {
  async send(_message: EmailMessage): Promise<void> {
    throw new AppError(503, "email_not_configured", "Email delivery is not configured. No message was sent.");
  }
}

/**
 * Placeholder for a future SMTP provider. A filled-in configuration does not open a connection:
 * a real provider needs separate approval. The error never includes host, user, or password.
 */
export class UnconnectedSmtpEmailSender implements EmailSender {
  async send(_message: EmailMessage): Promise<void> {
    throw new AppError(503, "email_not_configured", "Email delivery is not connected yet. No message was sent.");
  }
}

export interface EmailSetup {
  sender: EmailSender;
  delivery: "outbox" | "unavailable";
  /** True only when a working local outbox will actually accept the message. */
  requireVerifiedEmail: boolean;
  outbox?: MemoryEmailOutbox;
}

/** Reads placeholders from the environment. Never reads or returns a secret in an error. */
export function createEmailSetup(env: NodeJS.ProcessEnv = process.env): EmailSetup {
  const choice = (env["CLIPFORGE_EMAIL_PROVIDER"] ?? "").trim().toLowerCase();
  if (choice === "outbox" && env["NODE_ENV"] !== "production") {
    const outbox = new MemoryEmailOutbox();
    return { sender: outbox, delivery: "outbox", requireVerifiedEmail: true, outbox };
  }
  if (choice === "smtp") {
    const ready = ["CLIPFORGE_SMTP_HOST", "CLIPFORGE_SMTP_PORT", "CLIPFORGE_SMTP_USER", "CLIPFORGE_SMTP_PASSWORD", "CLIPFORGE_EMAIL_FROM"].every((name) => (env[name] ?? "").trim().length > 0);
    if (ready) return { sender: new UnconnectedSmtpEmailSender(), delivery: "unavailable", requireVerifiedEmail: false };
  }
  return { sender: new UnavailableEmailSender(), delivery: "unavailable", requireVerifiedEmail: false };
}

export class MemoryEmailOutbox implements EmailSender {
  messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> { this.messages.push(structuredClone(message)); }
}

/**
 * The link opens a page with a confirm BUTTON (a POST). A plain GET never consumes the token, so email scanners
 * that "click" links cannot verify accounts or burn reset links.
 */
export const verificationEmail = (to: string, baseUrl: string, token: string): EmailMessage => ({
  to, subject: "Confirm your ClipForge email",
  text: `Open this link and press "Confirm" to verify your email (valid for 24 hours):\n${baseUrl}/verify-email?token=${token}\n\nIf you did not create an account, ignore this message.`,
});
export const passwordResetEmail = (to: string, baseUrl: string, token: string): EmailMessage => ({
  to, subject: "Reset your ClipForge password",
  text: `Open this link to choose a new password (valid for 1 hour):\n${baseUrl}/reset-password?token=${token}\n\nIf you did not ask for this, ignore this message; your password has not changed.`,
});
