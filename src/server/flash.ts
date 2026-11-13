// One-time messages shown after a form submission, passed in the redirect URL as SHORT CODES.
// The page maps a code to a fixed sentence from this file. User-supplied text is never put in the URL
// or shown back, so a crafted link cannot inject content. Numbers are clamped to digits only.
import { AppError } from "./errors.ts";

export const FLASH_NOTICES = {
  upload_ok: "Upload complete. The file was checked and saved.",
  upload_incomplete: "Upload complete, but the file was accepted by its file signature only: its length and size could not be checked because ffprobe is not installed on this server.",
  cycle_created: "Cycle created. Add and review its videos, then plan a schedule; no Reel was published.",
  cycle_started: "Cycle marked as running in ClipForge. No Reel was published by this action.",
  cycle_paused: "Cycle paused in ClipForge. An item already in progress is not interrupted.",
  cycle_resumed: "Cycle marked as running again in ClipForge. This action does not publish a Reel.",
  cycle_stopped: "Cycle stopped. Unstarted items were cancelled; already-published posts were not changed and no Reel was published.",
  cycle_repeat_saved: "Repeat mode saved. Only eligible unpublished items can enter another round, according to this setting; nothing was published by saving it.",
  cycle_schedule_saved: "Schedule saved in ClipForge. Review the planned dates in this cycle; no Reel was published.",
  cycle_render_output_saved: "Rendered output selected for this cycle item. The original video is unchanged; no Reel was published.",
  cycle_render_output_cleared: "Rendered output selection cleared. This item needs a selected render before it can pass publishing preflight.",
  captions_applied: "Caption update finished.",
  covers_applied: "Cover update finished. Covers are saved in ClipForge; Instagram has not received them.",
  videos_added: "Videos added to the cycle.",
  registered: "If that email address can be used, the account was saved. Check the inbox for its confirmation message.",
  registered_no_email: "If that email address can be used, the account is saved in the database. Email confirmation is not available yet, so no message was sent. You can sign in, and the account stays unverified until email delivery is configured.",
  reset_unavailable: "Password reset by email is not available yet. No message was sent.",
  verified: "Your email is confirmed. You can sign in now.",
  logged_out: "You are signed out.",
  reset_email_sent: "If that email belongs to a confirmed account, password reset instructions would be sent when email delivery is configured. No email was sent.",
  password_changed: "Your password was changed and you were signed out everywhere. Sign in with the new password.",
  template_saved: "Template saved. Your original video was not changed.",
  template_exists: "That template is already saved, so no duplicate was created.",
  settings_saved: "Settings saved for this video. The original file was not changed.",
  bulk_review: "Review these changes. Nothing has been saved yet.",
  bulk_applied: "Bulk edit applied. Only the ticked settings changed, and each original file was kept.",
  renders_queued: "Rendering has started for the videos below. Each one is a new file. The originals are kept.",
  render_queued: "Rendering has started. This page updates until the export is ready. The original video is not changed.",
  collection_created: "Collection saved in the database.",
  collection_updated: "Collection details saved.",
  collection_media_saved: "The videos in this collection were saved. The original files were not deleted.",
  collection_video_settings_saved: "This video's collection settings were saved. Its source media was not changed.",
  collection_shared_settings_saved: "Collection defaults were saved. Individual settings remain intact; cycle edits stay separate.",
  collection_archived: "Collection archived. The videos are still in your library.",
  collection_restored: "Collection restored.",
  collection_deleted: "Collection deleted. The videos are still in your library and in any other collection.",
  sharing_grant_created: "Collection access saved. The owner’s plan limits and sharing permissions were checked.",
  sharing_grant_revoked: "Collection access revoked. Existing published history was not changed.",
  share_link_updated: "Share-link permissions were updated. The raw link is not shown again.",
  share_link_revoked: "Share link revoked. Its token can no longer open this collection.",
  share_link_already_revoked: "That share link was already revoked.",
  access_request_created: "Access request sent. No access is granted until the collection owner approves it.",
  access_request_existing: "You already have a pending request for that collection.",
  access_request_approved: "Access request approved. The grant follows the collection owner's current plan limits.",
  access_request_rejected: "Access request rejected. No collection access was granted.",
  instagram_connected: "Instagram is connected. The access token stays on the server. No Reel has been published.",
  instagram_disconnected: "Instagram is disconnected. The token was removed. Your videos and cycles were not deleted.",
  videos_removed: "Videos removed from the cycle. Already-published posts are not affected.",
  google_connected: "Google is connected to this account. Email and password sign-in still works.",
} as const;

export const FLASH_ERRORS = {
  admin_login_failed: "Sign-in failed. Check your credentials and try again.",
  invalid_credentials: "Email or password is not correct.",
  email_not_verified: "Please confirm your email address before signing in.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  invalid_token: "That link is not valid or has expired.",
  weak_password: "Choose a stronger password: at least 10 characters, not a common password, not your email address.",
  invalid_email: "Enter a valid email address.",
  auth_not_available: "Sign-in is not available in this build.",
  validation_failed: "Some of the fields are not valid. Check them and try again.",
  not_authenticated: "Please sign in first.",
  database_unavailable: "The database could not confirm that operation. It may not have been saved; check again before retrying.",
  not_found: "We could not find that, or you do not have access to it.",
  forbidden: "You are not allowed to do that.",
  plan_limit: "Your plan does not allow that many at once. Nothing was changed.",
  conflict: "Someone or something else changed this at the same moment. Reload the page and try again.",
  preflight_failed: "This cycle cannot start yet. See the checks below.",
  file_too_large: "That file is too large for one upload.",
  unsupported_media_type: "That file is not a supported video or image, or its contents do not match its type.",
  invalid_media: "That file could not be read as valid media, so it was not saved.",
  storage_not_configured: "Uploads are not available: no storage is configured.",
  storage_unavailable: "The private media folder is not available. Nothing was saved in memory.",
  email_not_configured: "Email delivery is not configured. No message was sent.",
  not_configured: "This feature is not connected yet in this build.",
  payload_too_large: "That request is too large.",
  length_required: "The upload did not say how large it is, so it was refused.",
  error: "Something went wrong. Please try again.",
  google_not_configured: "Google sign-in is not connected yet. Email and password still work.",
  google_cancelled: "Google sign-in was cancelled. No account was changed.",
  google_invalid_state: "That Google sign-in attempt expired or did not match this browser. Please try again.",
  google_expired_code: "That Google sign-in code expired. Please try again.",
  google_email_unverified: "Google did not confirm that email address, so no account was created or linked.",
  google_account_exists: "An account with that email already exists. Sign in with your password, then connect Google from the app.",
  google_identity_taken: "That Google account is already connected to a ClipForge account.",
  google_link_mismatch: "Google was not connected. Sign in with the password for this verified email, then try again.",
  google_callback_error: "Google sign-in could not be completed. Please try again.",
  google_invalid_profile: "Google did not return a usable account, so nothing was changed.",
  instagram_not_configured: "Instagram is not configured. Add your own Meta app credentials. ClipForge does not create that app.",
  instagram_cancelled: "Instagram connection was cancelled. No account was changed.",
  instagram_invalid_state: "That Instagram connection expired or did not match this browser. Please try again.",
  instagram_expired_code: "That Instagram connection code expired. Please try again.",
  instagram_missing_permission: "Instagram did not grant the publishing permissions, so nothing was saved.",
  instagram_unsupported_account: "Only a confirmed supported Instagram professional account can be connected. This account was not saved.",
  instagram_callback_error: "Instagram could not be connected. Please try again.",
} as const;

export type FlashNoticeCode = keyof typeof FLASH_NOTICES;

/** The create-collection notice must name the storage that was actually used. */
export function collectionCreatedMessage(mode: "database" | "local" | "demo" | "unconfigured"): string {
  return mode === "database"
    ? FLASH_NOTICES.collection_created
    : "Collection saved in server memory. It disappears when the server restarts.";
}
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
const EXTRA_KEYS = ["media", "job", "draft", "batch"] as const;
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
