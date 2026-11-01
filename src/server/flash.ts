// One-time messages shown after a form submission, passed in the redirect URL as SHORT CODES.
// The page maps a code to a fixed sentence from this file. User-supplied text is never put in the URL
// or shown back, so a crafted link cannot inject content. Numbers are clamped to digits only.
import { AppError } from "./errors.ts";

export const FLASH_NOTICES = {
  upload_ok: "Upload complete. The file was checked and saved.",
  upload_incomplete: "Upload complete, but the file was accepted by its file signature only: its length and size could not be checked because ffprobe is not installed on this server.",
  cycle_created: "Publishing cycle created. Nothing is published yet.",
  cycle_started: "Cycle started.",
  captions_applied: "Caption update finished.",
  covers_applied: "Cover update finished. Covers are saved in ClipForge; Instagram has not received them.",
  videos_added: "Videos added to the cycle.",
  registered: "If that email address can be used, we sent a confirmation link. Check your inbox (in local development mode the message is on the outbox page).",
  verified: "Your email is confirmed. You can sign in now.",
  logged_out: "You are signed out.",
  reset_email_sent: "If that email belongs to a confirmed account, we sent a password reset link.",
  password_changed: "Your password was changed and you were signed out everywhere. Sign in with the new password.",
  template_saved: "Template saved. Your original video was not changed.",
  videos_removed: "Videos removed from the cycle. Already-published posts are not affected.",
} as const;

export const FLASH_ERRORS = {
  invalid_credentials: "Email or password is not correct.",
  email_not_verified: "Please confirm your email first. Check your inbox for the link.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  invalid_token: "That link is not valid or has expired.",
  weak_password: "Choose a stronger password: at least 10 characters, not a common password, not your email address.",
  invalid_email: "Enter a valid email address.",
  auth_not_available: "Sign-in is not available in this build.",
  validation_failed: "Some of the fields are not valid. Check them and try again.",
  not_authenticated: "Please sign in first. (Real sign-in is not available yet in this build.)",
  not_found: "We could not find that, or you do not have access to it.",
  forbidden: "You are not allowed to do that.",
  plan_limit: "Your plan does not allow that (for example a storage or campaign limit).",
  conflict: "Someone or something else changed this at the same moment. Reload the page and try again.",
  preflight_failed: "This cycle cannot start yet. See the checks below.",
  file_too_large: "That file is too large for one upload.",
  unsupported_media_type: "That file is not a supported video or image, or its contents do not match its type.",
  invalid_media: "That file could not be read as valid media, so it was not saved.",
  storage_not_configured: "Uploads are not available: no storage is configured.",
  not_configured: "This feature is not connected yet in this build.",
  payload_too_large: "That request is too large.",
  length_required: "The upload did not say how large it is, so it was refused.",
  error: "Something went wrong. Please try again.",
} as const;

export type FlashNoticeCode = keyof typeof FLASH_NOTICES;
export type FlashErrorCode = keyof typeof FLASH_ERRORS;

const COUNT_KEYS = ["updated", "skipped", "conflicts", "confirm", "added", "rejected", "removed", "blocked"] as const;
const COUNT_LABELS: Record<(typeof COUNT_KEYS)[number], string> = { updated: "updated", skipped: "skipped", conflicts: "conflicts", confirm: "need confirmation", added: "added", rejected: "not added", removed: "removed", blocked: "could not be removed" };

const isNotice = (code: string): code is FlashNoticeCode => Object.prototype.hasOwnProperty.call(FLASH_NOTICES, code);
const isError = (code: string): code is FlashErrorCode => Object.prototype.hasOwnProperty.call(FLASH_ERRORS, code);

/** Map any thrown error to one of our known error codes. */
export function flashCodeForError(error: unknown): FlashErrorCode {
  if (error instanceof AppError) {
    if (isError(error.code)) return error.code;
    return ({ 401: "not_authenticated", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "payload_too_large", 422: "validation_failed", 503: "not_configured" } as Record<number, FlashErrorCode>)[error.status] ?? "error";
  }
  return "error";
}

const SAFE_PATH = /^\/[A-Za-z0-9_\/-]{0,200}$/;

/** Builds the redirect target. The path must be a plain internal path (no "//", no scheme, no query). */
const EXTRA_KEYS = ["media"] as const;
const EXTRA_VALUE = /^[A-Za-z0-9_-]{1,64}$/;

export function buildFlashLocation(path: string, kind: "notice" | "error", code: string, counts: Partial<Record<(typeof COUNT_KEYS)[number], number>> = {}, extra: Partial<Record<(typeof EXTRA_KEYS)[number], string>> = {}): string {
  if (!SAFE_PATH.test(path) || path.startsWith("//")) throw new Error("Unsafe redirect path.");
  const params = new URLSearchParams();
  const known = kind === "notice" ? isNotice(code) : isError(code);
  params.set(kind, known ? code : kind === "notice" ? "cycle_started" : "error");
  if (!known && kind === "notice") throw new Error("Unknown notice code.");
  for (const key of COUNT_KEYS) { const value = counts[key]; if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 9999) params.set(key, String(value)); }
  for (const key of EXTRA_KEYS) { const v = extra[key]; if (typeof v === "string" && EXTRA_VALUE.test(v)) params.set(key, v); }
  return `${path}?${params.toString()}`;
}

export interface Flash { kind: "notice" | "error"; message: string; }

/** Reads the flash from a page's search params. Unknown or malformed values are ignored. */
export function parseFlash(searchParams: Record<string, string | string[] | undefined> | undefined): Flash | null {
  if (!searchParams) return null;
  const one = (key: string): string | undefined => { const v = searchParams[key]; return typeof v === "string" ? v : undefined; };
  const notice = one("notice"), error = one("error");
  let flash: Flash | null = null;
  if (notice && isNotice(notice)) flash = { kind: "notice", message: FLASH_NOTICES[notice] };
  else if (error && isError(error)) flash = { kind: "error", message: FLASH_ERRORS[error] };
  if (!flash) return null;
  const parts: string[] = [];
  for (const key of COUNT_KEYS) { const v = one(key); if (v !== undefined && /^\d{1,4}$/.test(v)) parts.push(`${Number(v)} ${COUNT_LABELS[key]}`); }
  return parts.length > 0 ? { ...flash, message: `${flash.message} (${parts.join(", ")})` } : flash;
}
