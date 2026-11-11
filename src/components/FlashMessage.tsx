import type { Flash } from "../server/flash.ts";
import { AuthToast } from "./AuthToast.tsx";

/** Result of the last form submission. Text comes only from a fixed whitelist (see flash.ts). */
export function FlashMessage({ flash, variant = "default" }: { flash: Flash | null; variant?: "default" | "toast" }) {
  if (!flash) return null;
  if (variant === "toast") return <AuthToast flash={flash} />;
  return flash.kind === "error"
    ? <p role="alert" aria-live="assertive" className="notice flash-error" data-flash="error">{flash.message}</p>
    : <p role="status" aria-live="polite" className="notice flash-notice" data-flash="notice">{flash.message}</p>;
}
