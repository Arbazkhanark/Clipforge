// Runs ffprobe / ffmpeg. This is WORKER code (Node only): never call it inside a web request.
// Uses spawn with an argument array and no shell.
import { spawn } from "node:child_process";
import { buildRenderArgs, parseProgressSeconds, progressPercent, validateRenderOutput, type ProbeResult, type RenderSettings, type SourceVideoInfo } from "./ffmpeg-command.ts";

function runCommand(command: string, args: string[], onStdout?: (chunk: string) => void, timeoutMs?: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false, timedOut = false;
    const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs) : null;
    const finish = (value: { code: number | null; stdout: string; stderr: string; timedOut: boolean }) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(value); };
    const fail = (error: Error) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); reject(error); };
    child.stdout.on("data", (d: Buffer) => { const text = d.toString(); stdout += text; onStdout?.(text); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
    child.on("error", fail);
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { code, stdout, stderr } = await runCommand("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath]);
  if (code !== 0) throw new Error(`ffprobe failed: ${stderr.slice(-300)}`);
  const info = JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format: { duration?: string } };
  const video = info.streams.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height) throw new Error("No video stream found.");
  return {
    width: video.width, height: video.height, videoCodec: video.codec_name,
    durationSeconds: Number(info.format.duration ?? 0), hasAudio: info.streams.some((s) => s.codec_type === "audio"),
  };
}

export interface RenderResult {
  /** true only when ffmpeg succeeded AND the output passed validation. Usage is charged only then. */
  succeeded: boolean;
  outputValidated: boolean;
  problems: string[];
  processingSeconds: number;
  outputProbe: ProbeResult | null;
}

export async function renderVideo(args: {
  inputPath: string; outputPath: string; logoPath?: string; backgroundImagePath?: string; settings: RenderSettings;
  timeoutMs?: number; onProgress?: (percent: number) => void;
}): Promise<RenderResult> {
  const startedAt = Date.now();
  const sourceProbe = await probeVideo(args.inputPath);
  const source: SourceVideoInfo = { width: sourceProbe.width, height: sourceProbe.height, durationSeconds: sourceProbe.durationSeconds };
  const plan = buildRenderArgs({ inputPath: args.inputPath, outputPath: args.outputPath, logoPath: args.logoPath, backgroundImagePath: args.backgroundImagePath, source, settings: args.settings });

  const { code, stderr, timedOut } = await runCommand("ffmpeg", plan.args, (chunk) => {
    const percent = progressPercent(parseProgressSeconds(chunk), source.durationSeconds);
    if (percent !== null) args.onProgress?.(percent);
  }, args.timeoutMs);
  const processingSeconds = (Date.now() - startedAt) / 1000;
  if (timedOut) return { succeeded: false, outputValidated: false, problems: ["Rendering took too long and was stopped."], processingSeconds, outputProbe: null };
  if (code !== 0) return { succeeded: false, outputValidated: false, problems: [`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`], processingSeconds, outputProbe: null };

  const outputProbe = await probeVideo(args.outputPath);
  const trimStart = args.settings.trim?.startSeconds ?? 0;
  const trimEnd = args.settings.trim?.endSeconds ?? source.durationSeconds;
  const check = validateRenderOutput(outputProbe, { width: plan.canvas.width, height: plan.canvas.height, durationSeconds: trimEnd - trimStart });
  if (check.valid) args.onProgress?.(100);
  return { succeeded: true, outputValidated: check.valid, problems: check.problems, processingSeconds, outputProbe };
}

/** Test/diagnostic helper: read one pixel (r,g,b) from a video's first frame. */
export async function readPixel(filePath: string, x: number, y: number): Promise<[number, number, number]> {
  const args = ["-v", "error", "-i", filePath, "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-"];
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", () => { const b = Buffer.concat(chunks); b.length >= 3 ? resolve([b[0]!, b[1]!, b[2]!]) : reject(new Error("Could not read pixel")); });
  });
}
