// Looking at what an upload REALLY is. The browser-supplied MIME type and file name are only hints:
// we read the file's own first bytes ("magic numbers"), and for video we ask ffprobe when it is installed.
import { spawn } from "node:child_process";
import { probeVideo } from "../../lib/render/render-runner.ts";

export type SniffedType = "mp4" | "mov" | "webm" | "jpeg" | "png" | "webp";
export interface Sniffed { kind: "video" | "image"; type: SniffedType; allowedMimeTypes: string[]; }

/** The canonical MIME type we store and serve for each real type (never the browser-supplied one). */
export const CANONICAL_MIME: Record<SniffedType, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.slice(from, to));

/** MP4/MOV "brands" we accept. Others (for example HEIC photos, which also start with "ftyp") are refused. */
const MP4_BRANDS = ["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VH", "M4VP", "dash", "msnv"];
const MOVIE_MIMES = ["video/mp4", "video/quicktime"];

/** Decides the real type from the bytes. Returns null for anything we do not accept. */
export function sniffMedia(bytes: Uint8Array): Sniffed | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: "image", type: "jpeg", allowedMimeTypes: ["image/jpeg", "image/jpg"] };
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return { kind: "image", type: "png", allowedMimeTypes: ["image/png"] };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { kind: "image", type: "webp", allowedMimeTypes: ["image/webp"] };
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { kind: "video", type: "webm", allowedMimeTypes: ["video/webm"] };
  const box = ascii(bytes, 4, 8);
  if (box === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "qt  ") return { kind: "video", type: "mov", allowedMimeTypes: MOVIE_MIMES };
    return MP4_BRANDS.includes(brand) ? { kind: "video", type: "mp4", allowedMimeTypes: MOVIE_MIMES } : null;
  }
  // Older QuickTime files can start with another box instead of "ftyp".
  if (["moov", "mdat", "wide"].includes(box)) return { kind: "video", type: "mov", allowedMimeTypes: MOVIE_MIMES };
  return null;
}

/** Does the browser's claim agree with the bytes? A missing or generic claim is fine; a contradicting one is not. */
export function declaredMimeAgrees(declared: string, sniffed: Sniffed): boolean {
  const normalised = declared.split(";")[0]!.trim().toLowerCase();
  if (normalised === "" || normalised === "application/octet-stream") return true;
  return sniffed.allowedMimeTypes.includes(normalised);
}

/**
 * A safe DISPLAY name. It is never used in a file path (storage keys come from ids), but it is shown in the
 * UI, so remove folders, control characters and markup-ish characters.
 */
export function sanitizeFilename(raw: string): string {
  const lastPart = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = lastPart
    .replace(/[\u0000-\u001f\u007f]/g, "")        // control characters, including null bytes
    .replace(/[<>:"|?*\\]/g, "")                   // characters that are special in paths or HTML
    .replace(/\s+/g, " ").trim()
    .replace(/^\.+/, "");                          // no hidden-file or ".." names
  const shortened = cleaned.slice(0, 100).trim();
  return shortened === "" ? "upload" : shortened;
}

// ---------- ffprobe ----------
export interface MediaProbeResult { width: number; height: number; durationSeconds: number; }
/** Reads a file with ffprobe. Throws if the file cannot be decoded as media. */
export type MediaProbe = (filePath: string) => Promise<MediaProbeResult>;

let ffprobeAvailable: Promise<boolean> | null = null;

/** True only if `ffprobe` really runs here. Checked once, then remembered. */
export function isFfprobeAvailable(): Promise<boolean> {
  ffprobeAvailable ??= new Promise<boolean>((resolve) => {
    const child = spawn("ffprobe", ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  return ffprobeAvailable;
}

/** The real probe (or null when ffprobe is not installed: callers must then say validation is incomplete). */
export async function detectProbe(): Promise<MediaProbe | null> {
  if (!(await isFfprobeAvailable())) return null;
  return async (filePath) => {
    const result = await probeVideo(filePath);
    return { width: result.width, height: result.height, durationSeconds: Number.isFinite(result.durationSeconds) ? result.durationSeconds : 0 };
  };
}

// ---------- thumbnails ----------
/** Turns a staged file into a small JPEG, or null if that is not possible. Never throws. */
export type ThumbnailMaker = (filePath: string, durationSeconds: number | null) => Promise<Uint8Array | null>;

export const THUMBNAIL_MAX_WIDTH = 320;
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

export const makeThumbnailWithFfmpeg: ThumbnailMaker = (filePath, durationSeconds) => new Promise((resolve) => {
  // A frame about 10% in (at most 3s) usually avoids a black first frame. Images just get scaled down.
  const seek = durationSeconds && durationSeconds > 1 ? Math.min(3, durationSeconds * 0.1) : 0;
  const args = ["-v", "error", "-nostdin", ...(seek > 0 ? ["-ss", seek.toFixed(2)] : []), "-i", filePath, "-frames:v", "1", "-vf", `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`, "-f", "mjpeg", "-q:v", "5", "pipe:1"];
  let child;
  try { child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] }); } catch { resolve(null); return; }
  const chunks: Uint8Array[] = []; let total = 0; let settled = false;
  const done = (value: Uint8Array | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
  const timer = setTimeout(() => { child.kill?.("SIGKILL"); done(null); }, 20_000);
  child.stdout.on("data", (d: Uint8Array) => { total += d.length; if (total > THUMBNAIL_MAX_BYTES) { child.kill?.("SIGKILL"); done(null); } else chunks.push(d); });
  child.on("error", () => done(null));
  child.on("close", () => {
    if (total === 0) return done(null);
    const bytes = new Uint8Array(total); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
    done(bytes[0] === 0xff && bytes[1] === 0xd8 ? bytes : null); // only accept real JPEG output
  });
});

let ffmpegAvailable: Promise<boolean> | null = null;
export function isFfmpegAvailable(): Promise<boolean> {
  ffmpegAvailable ??= new Promise<boolean>((resolve) => { const c = spawn("ffmpeg", ["-version"], { stdio: "ignore" }); c.on("error", () => resolve(false)); c.on("close", (code: number | null) => resolve(code === 0)); });
  return ffmpegAvailable;
}
export async function detectThumbnailMaker(): Promise<ThumbnailMaker | null> { return (await isFfmpegAvailable()) ? makeThumbnailWithFfmpeg : null; }
