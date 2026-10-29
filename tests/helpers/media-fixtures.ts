// Real, tiny media files generated with ffmpeg for tests (no binary files are committed).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0;

export interface Fixtures { mp4: Uint8Array; png: Uint8Array; jpeg: Uint8Array; cleanup: () => void; }

export function makeFixtures(): Fixtures {
  const dir = mkdtempSync(join(tmpdir(), "clipforge-fixtures-"));
  const run = (args: string[]) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args]); if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}`); };
  run(["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10:duration=1", "-pix_fmt", "yuv420p", "-c:v", "libx264", join(dir, "a.mp4")]);
  run(["-f", "lavfi", "-i", "testsrc2=size=64x64", "-frames:v", "1", join(dir, "a.png")]);
  run(["-f", "lavfi", "-i", "testsrc2=size=64x64", "-frames:v", "1", join(dir, "a.jpg")]);
  const read = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
  return { mp4: read("a.mp4"), png: read("a.png"), jpeg: read("a.jpg"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Bytes that LOOK like an MP4 (valid "ftyp" header) but contain no real video. */
export function fakeMp4(): Uint8Array {
  const bytes = new Uint8Array(200);
  bytes.set([0, 0, 0, 0x18], 0); bytes.set(new TextEncoder().encode("ftypisom"), 4);
  for (let i = 12; i < bytes.length; i++) bytes[i] = (i * 37) % 251;
  return bytes;
}
