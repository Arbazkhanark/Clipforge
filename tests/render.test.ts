import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildRenderArgs, canvasSizeFor, validateRenderSettings, parseProgressSeconds, progressPercent, validateRenderOutput,
  InvalidRenderSettingsError, type RenderSettings, type SourceVideoInfo,
} from "../src/lib/render/ffmpeg-command.ts";
import { renderVideo, probeVideo, readPixel } from "../src/lib/render/render-runner.ts";

const SOURCE: SourceVideoInfo = { width: 320, height: 240, durationSeconds: 2 };
const settings = (over: Partial<RenderSettings> = {}): RenderSettings => ({
  aspect: "9:16", maxResolution: "720p", background: { kind: "solid", colorHex: "#ff00ff" }, zoom: 1, offsetX: 0, offsetY: 0,
  border: { thicknessPx: 10, colorHex: "#00ff00" }, ...over,
});

// ---------- Pure tests ----------
test("canvas sizes per aspect ratio, capped by plan resolution", () => {
  assert.deepEqual(canvasSizeFor("9:16", "1080p", SOURCE), { width: 1080, height: 1920 });
  assert.deepEqual(canvasSizeFor("9:16", "720p", SOURCE), { width: 720, height: 1280 });
  assert.deepEqual(canvasSizeFor("4:5", "720p", SOURCE), { width: 720, height: 900 });
  assert.deepEqual(canvasSizeFor("1:1", "720p", SOURCE), { width: 720, height: 720 });
  assert.deepEqual(canvasSizeFor("16:9", "720p", SOURCE), { width: 1280, height: 720 });
  assert.deepEqual(canvasSizeFor("original", "720p", SOURCE), { width: 320, height: 240 });
  assert.deepEqual(canvasSizeFor("original", "original", { width: 3840, height: 2160, durationSeconds: 1 }), { width: 3840, height: 2160 });
});

test("main video geometry: border surrounds the video box, not the canvas", () => {
  const plan = buildRenderArgs({ inputPath: "in.mp4", outputPath: "out.mp4", source: SOURCE, settings: settings() });
  assert.deepEqual(plan.canvas, { width: 720, height: 1280 });
  // Fit 320x240 into 720x1280 => 720x540. Box = video + 10px border each side.
  assert.deepEqual(plan.mainVideo, { width: 740, height: 560, x: -10, y: 360 });
});

test("zoom and offsets move/size the main video", () => {
  const zoomed = buildRenderArgs({ inputPath: "i", outputPath: "o", source: SOURCE, settings: settings({ zoom: 1.5, border: { thicknessPx: 0, colorHex: "#000000" } }) });
  assert.equal(zoomed.mainVideo.width, 1080);
  const moved = buildRenderArgs({ inputPath: "i", outputPath: "o", source: SOURCE, settings: settings({ offsetX: 0.5, offsetY: -0.5, border: { thicknessPx: 0, colorHex: "#000000" } }) });
  assert.deepEqual([moved.mainVideo.x, moved.mainVideo.y], [180, 50]);
});

test("settings are validated; unsafe colours cannot reach the filter graph", () => {
  const evil = settings({ background: { kind: "solid", colorHex: "#ff0000[x];movie=/etc/passwd" } });
  assert.throws(() => buildRenderArgs({ inputPath: "i", outputPath: "o", source: SOURCE, settings: evil }), InvalidRenderSettingsError);
  const bad: Partial<RenderSettings>[] = [{ zoom: 0.5 }, { zoom: 4 }, { offsetX: 2 }, { aspect: "2:1" as never }, { maxResolution: "4k" as never },
    { border: { thicknessPx: 99, colorHex: "#000000" } }, { border: { thicknessPx: 1.5, colorHex: "#000000" } }, { border: { thicknessPx: 5, colorHex: "red" } },
    { background: { kind: "blur", strength: 100 } }, { logo: { widthFraction: 0.9, centerX: 0.5, centerY: 0.5, opacity: 1 } }];
  for (const over of bad) assert.ok(validateRenderSettings(settings(over), SOURCE).length > 0, JSON.stringify(over));
  assert.throws(() => buildRenderArgs({ inputPath: "i", outputPath: "o", source: SOURCE, settings: settings({ logo: { widthFraction: 0.2, centerX: 0.5, centerY: 0.5, opacity: 1 } }) }), /logo file/);
  assert.equal(validateRenderSettings(settings(), { width: 0, height: 0, durationSeconds: 0 }).length, 1);
});

test("the plan's resolution cap is applied to the actual command", () => {
  const free = buildRenderArgs({ inputPath: "i", outputPath: "o", source: SOURCE, settings: settings({ maxResolution: "720p" }) });
  const pro = buildRenderArgs({ inputPath: "i", outputPath: "o", source: SOURCE, settings: settings({ maxResolution: "1080p" }) });
  assert.equal(free.canvas.width, 720); assert.equal(pro.canvas.width, 1080);
});

test("args never use a shell string and keep paths as separate arguments", () => {
  const path = "my video; rm -rf /.mp4";
  const plan = buildRenderArgs({ inputPath: path, outputPath: "out.mp4", source: SOURCE, settings: settings() });
  assert.ok(plan.args.includes(path));
  assert.ok(!plan.args.join(" ").includes("sh -c"));
});

test("progress parsing is honest: only real percentages, capped at 99 until validated", () => {
  assert.equal(parseProgressSeconds("frame=10\nout_time=00:00:01.500000\nprogress=continue\n"), 1.5);
  assert.equal(parseProgressSeconds("out_time=00:00:01.000000\nout_time=00:01:02.250000\n"), 62.25);
  assert.equal(parseProgressSeconds("frame=1\n"), null);
  assert.equal(progressPercent(1, 4), 25);
  assert.equal(progressPercent(10, 4), 99);
  assert.equal(progressPercent(null, 4), null);
  assert.equal(progressPercent(1, 0), null);
});

test("output validation catches wrong size, codec and duration", () => {
  const good = { width: 720, height: 1280, durationSeconds: 2.02, hasAudio: true, videoCodec: "h264" };
  const expected = { width: 720, height: 1280, durationSeconds: 2 };
  assert.equal(validateRenderOutput(good, expected).valid, true);
  assert.equal(validateRenderOutput({ ...good, width: 700 }, expected).valid, false);
  assert.equal(validateRenderOutput({ ...good, videoCodec: "vp9" }, expected).valid, false);
  assert.equal(validateRenderOutput({ ...good, durationSeconds: 0.2 }, expected).valid, false);
});

// ---------- Real FFmpeg integration ----------
const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0;
let workDir = "";
before(() => {
  if (!ffmpegAvailable) return;
  workDir = mkdtempSync(join(tmpdir(), "clipforge-render-"));
  const make = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(workDir, "source.mp4")]);
  assert.equal(make.status, 0, "could not create the test source video");
  const logo = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xffff00:s=100x50", "-frames:v", "1", join(workDir, "logo.png")]);
  assert.equal(logo.status, 0);
});
after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }); });

const near = (actual: [number, number, number], expected: [number, number, number], tolerance = 40) =>
  assert.ok(actual.every((v, i) => Math.abs(v - (expected[i] as number)) <= tolerance), `pixel ${actual} not near ${expected}`);

test("REAL FFMPEG: solid background + main-video border renders to a validated 9:16 file", { skip: !ffmpegAvailable && "ffmpeg not installed" }, async () => {
  const out = join(workDir, "solid.mp4");
  const progress: number[] = [];
  const result = await renderVideo({ inputPath: join(workDir, "source.mp4"), outputPath: out, settings: settings(), onProgress: (p) => progress.push(p) });
  assert.deepEqual(result.problems, []);
  assert.equal(result.succeeded, true); assert.equal(result.outputValidated, true);
  const probe = await probeVideo(out);
  assert.deepEqual([probe.width, probe.height, probe.videoCodec, probe.hasAudio], [720, 1280, "h264", true]);
  assert.ok(Math.abs(probe.durationSeconds - 2) < 0.3);
  assert.equal(progress[progress.length - 1], 100);
  // Pixels: canvas edge = background colour; strip just above the video = BORDER colour; far corner not bordered.
  near(await readPixel(out, 360, 5), [255, 0, 255]);        // top of canvas: magenta background
  near(await readPixel(out, 360, 365), [0, 255, 0]);        // border above the main video: green
  near(await readPixel(out, 5, 640), [0, 255, 0], 255);     // (sanity read works)
  const middle = await readPixel(out, 360, 640);            // inside the video: neither bg nor border
  assert.ok(!(middle[0] > 200 && middle[1] < 60 && middle[2] > 200), "centre should show the video, not the background");
});

test("REAL FFMPEG: blurred background + logo overlay + 1:1 + 720p cap", { skip: !ffmpegAvailable && "ffmpeg not installed" }, async () => {
  const out = join(workDir, "blur.mp4");
  const result = await renderVideo({
    inputPath: join(workDir, "source.mp4"), outputPath: out, logoPath: join(workDir, "logo.png"),
    settings: settings({ aspect: "1:1", background: { kind: "blur", strength: 20 }, border: { thicknessPx: 0, colorHex: "#000000" }, logo: { widthFraction: 0.2, centerX: 0.5, centerY: 0.1, opacity: 1 } }),
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.outputValidated, true);
  assert.deepEqual([result.outputProbe!.width, result.outputProbe!.height], [720, 720]);
  near(await readPixel(out, 360, 72), [255, 255, 0], 60); // yellow logo centred at 50%, 10%
});

test("REAL FFMPEG: a missing input file fails cleanly and is NOT reported as success (so no usage is charged)", { skip: !ffmpegAvailable && "ffmpeg not installed" }, async () => {
  await assert.rejects(() => renderVideo({ inputPath: join(workDir, "nope.mp4"), outputPath: join(workDir, "x.mp4"), settings: settings() }));
  assert.equal(existsSync(join(workDir, "x.mp4")), false);
});
