import type { Flash } from "../server/flash.ts";

/** Result of the last form submission. Text comes only from a fixed whitelist (see flash.ts). */
export function FlashMessage({ flash }: { flash: Flash | null }) {
  if (!flash) return null;
  return flash.kind === "error"
    ? <p role="alert" className="notice flash-error" data-flash="error">{flash.message}</p>
    : <p role="status" className="notice flash-notice" data-flash="notice">{flash.message}</p>;
}
