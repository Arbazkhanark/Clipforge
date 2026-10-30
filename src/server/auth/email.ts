// Email goes through an interface. No provider is configured, so nothing is ever really sent: the dev adapter
// keeps messages in a memory "outbox". Do not claim email delivery works until a provider is configured and tested.
export interface EmailMessage { to: string; subject: string; text: string; }
export interface EmailSender { send(message: EmailMessage): Promise<void>; }

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
