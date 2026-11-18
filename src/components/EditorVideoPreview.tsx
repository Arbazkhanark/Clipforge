"use client";

import { useEffect, useMemo, useState } from "react";
import { computePreviewLayout, editorCandidateFromFields, parseEditingSettings, trimDurationProblems, type EditingSettings } from "../lib/domain/editing-settings.ts";
import { clampEditorOffset, clampEditorZoom, formatEditorZoomPercent, panEditorCamera, pinchEditorZoom, resetEditorCamera, stepEditorZoom, wheelEditorZoom, type EditorCamera } from "../lib/domain/editor-gestures.ts";
import type { MaxResolution } from "../lib/render/ffmpeg-command.ts";
import { LogoDragger } from "./LogoDragger.tsx";

export interface EditorPreviewImage { id: string; url: string; width: number | null; height: number | null; }

function formCamera(form: HTMLFormElement, fallback: EditorCamera): EditorCamera {
  const value = (name: string, current: number) => {
    const field = form.elements.namedItem(name);
    const parsed = field instanceof HTMLInputElement ? Number(field.value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : current;
  };
  return { zoom: clampEditorZoom(value("zoom", fallback.zoom)), offsetX: clampEditorOffset(value("offsetX", fallback.offsetX)), offsetY: clampEditorOffset(value("offsetY", fallback.offsetY)) };
}

function writeFormCamera(form: HTMLFormElement, camera: EditorCamera): void {
  const values: Record<string, number> = { zoom: clampEditorZoom(camera.zoom), offsetX: clampEditorOffset(camera.offsetX), offsetY: clampEditorOffset(camera.offsetY) };
  for (const [name, value] of Object.entries(values)) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement) field.value = String(value);
  }
  form.dispatchEvent(new Event("input", { bubbles: true }));
}

export function EditorVideoPreview({
  videoUrl, sourceId, sourceWidth, sourceHeight, durationMs, assumedSourceSize = false, settings: initialSettings, controlledSettings, maxResolution, images, formId,
}: {
  videoUrl: string; sourceId: string; sourceWidth: number | null; sourceHeight: number | null; durationMs: number | null;
  assumedSourceSize?: boolean;
  settings: EditingSettings; maxResolution: MaxResolution; images: EditorPreviewImage[]; formId: string;
  /** Optional parent-controlled preview settings. The normal editor continues reading its form as before. */
  controlledSettings?: EditingSettings;
}) {
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const [originalVideoElement, setOriginalVideoElement] = useState<HTMLVideoElement | null>(null);
  const [backgroundVideoElement, setBackgroundVideoElement] = useState<HTMLVideoElement | null>(null);
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const [settings, setSettings] = useState(initialSettings);
  const [invalidRange, setInvalidRange] = useState(false);
  const [rangeMessage, setRangeMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [playbackError, setPlaybackError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [comparisonMode, setComparisonMode] = useState<"original" | "edited">("edited");
  const [actualDuration, setActualDuration] = useState<number | null>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const imageById = useMemo(() => new Map(images.map((image) => [image.id, image])), [images]);
  const sourceSize = { width: sourceWidth ?? 1920, height: sourceHeight ?? 1080 };
  const logoInfo = settings.logo ? imageById.get(settings.logo.mediaId) : undefined;
  const logoAspect = logoInfo?.width && logoInfo.height ? logoInfo.width / logoInfo.height : 1;
  const layout = computePreviewLayout(settings, sourceSize, logoAspect, maxResolution);
  const durationSeconds = actualDuration ?? (durationMs && durationMs > 0 ? durationMs / 1000 : null);
  const trimStart = settings.trim.startSeconds;
  const trimEnd = settings.trim.endSeconds ?? durationSeconds ?? Infinity;
  const logoUrl = logoInfo?.url;
  const backgroundInfo = settings.background.kind === "image" ? imageById.get(settings.background.mediaId) : undefined;

  useEffect(() => {
    if (controlledSettings) setSettings(controlledSettings);
  }, [controlledSettings]);

  useEffect(() => {
    const stage = stageElement;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setDisplayScale(stage.clientWidth / layout.canvas.width));
    observer.observe(stage); setDisplayScale(stage.clientWidth / layout.canvas.width);
    return () => observer.disconnect();
  }, [layout.canvas.width, stageElement]);

  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    const readCurrentSettings = () => {
      const parsed = parseEditingSettings(editorCandidateFromFields((key) => {
        const field = form.elements.namedItem(key);
        if (field instanceof RadioNodeList) return field.value || undefined;
        return field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value || undefined : undefined;
      }, () => Number.NaN));
      if (!parsed.ok) {
        setInvalidRange(true); setRangeMessage(parsed.problems.find((problem) => /trim/i.test(problem)) ?? "The current editor settings are invalid.");
        return;
      }
      const sourceDuration = actualDuration ?? (durationMs && durationMs > 0 ? durationMs / 1000 : null);
      const problems = sourceDuration === null ? [] : trimDurationProblems(parsed.settings.trim, sourceDuration);
      setInvalidRange(problems.length > 0);
      setRangeMessage(problems[0] ?? "");
      setSettings(parsed.settings);
      const outputs: Record<string, string> = {
        zoom: formatEditorZoomPercent(parsed.settings.zoom),
        offsetX: parsed.settings.offsetX.toFixed(2), offsetY: parsed.settings.offsetY.toFixed(2),
      };
      for (const [name, value] of Object.entries(outputs)) {
        const output = document.getElementById(`editor-range-${name}-value`);
        if (output) output.textContent = value;
      }
    };
    form.addEventListener("input", readCurrentSettings);
    form.addEventListener("change", readCurrentSettings);
    return () => { form.removeEventListener("input", readCurrentSettings); form.removeEventListener("change", readCurrentSettings); };
  }, [actualDuration, durationMs, formId]);

  useEffect(() => {
    const video = videoElement;
    if (!video) return;
    if (invalidRange) { video.pause(); return; }
    const start = Math.min(trimStart, Number.isFinite(video.duration) ? video.duration : trimStart);
    if (video.currentTime < start || video.currentTime >= trimEnd) video.currentTime = start;
  }, [videoElement, invalidRange, trimStart, trimEnd]);

  useEffect(() => {
    const stage = stageElement;
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!stage || !form) return;
    type Point = { x: number; y: number };
    type Gesture = { mode: "pan" | "pinch"; camera: EditorCamera; startPoint: Point; startMidpoint: Point; startDistance: number };
    const pointers = new Map<number, Point>();
    let gesture: Gesture | null = null;
    let gestureStarted = false;
    const announceStart = () => { if (!gestureStarted) { form.dispatchEvent(new Event("clipforge:gesturestart")); gestureStarted = true; } };
    const announceEnd = () => { if (gestureStarted) form.dispatchEvent(new Event("clipforge:gestureend")); gestureStarted = false; };
    const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
    const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const twoPoints = (): [Point, Point] | null => { const points = [...pointers.values()]; return points.length >= 2 ? [points[0]!, points[1]!] : null; };
    const excludedTarget = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest("[data-logo-handle]"));
    const onPointerDown = (event: PointerEvent) => {
      if (excludedTarget(event.target) || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault();
      try { stage.setPointerCapture(event.pointerId); } catch { /* A detached preview cannot capture; it is removed with its listeners. */ }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const camera = formCamera(form, settings);
      const pair = twoPoints();
      if (pair) gesture = { mode: "pinch", camera, startPoint: pair[0], startMidpoint: midpoint(pair[0], pair[1]), startDistance: Math.max(1, distance(pair[0], pair[1])) };
      else gesture = { mode: "pan", camera, startPoint: { x: event.clientX, y: event.clientY }, startMidpoint: { x: event.clientX, y: event.clientY }, startDistance: 0 };
      announceStart();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId) || !gesture) return;
      event.preventDefault(); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pair = twoPoints();
      if (gesture.mode === "pinch" && pair) {
        const center = midpoint(pair[0], pair[1]);
        const offsets = panEditorCamera(gesture.camera, center.x - gesture.startMidpoint.x, center.y - gesture.startMidpoint.y, stage.clientWidth, stage.clientHeight);
        writeFormCamera(form, { ...offsets, zoom: pinchEditorZoom(gesture.camera.zoom, gesture.startDistance, distance(pair[0], pair[1])) });
      } else {
        const point = pointers.values().next().value as Point | undefined;
        if (point) {
          const offsets = panEditorCamera(gesture.camera, point.x - gesture.startPoint.x, point.y - gesture.startPoint.y, stage.clientWidth, stage.clientHeight);
          writeFormCamera(form, { ...offsets, zoom: gesture.camera.zoom });
        }
      }
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      if (pointers.size === 0) { gesture = null; announceEnd(); return; }
      const point = pointers.values().next().value as Point | undefined;
      if (point) gesture = { mode: "pan", camera: formCamera(form, settings), startPoint: point, startMidpoint: point, startDistance: 0 };
    };
    const onWheel = (event: WheelEvent) => {
      if (excludedTarget(event.target)) return;
      event.preventDefault();
      const camera = formCamera(form, settings);
      writeFormCamera(form, { ...camera, zoom: wheelEditorZoom(camera.zoom, event.deltaY) });
    };
    const onZoomClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-zoom-action]") : null;
      if (!target) return;
      event.preventDefault();
      const camera = formCamera(form, settings);
      const action = target.dataset["zoomAction"];
      if (action === "reset") writeFormCamera(form, resetEditorCamera());
      else if (action === "in") writeFormCamera(form, { ...camera, zoom: stepEditorZoom(camera.zoom, 1) });
      else if (action === "out") writeFormCamera(form, { ...camera, zoom: stepEditorZoom(camera.zoom, -1) });
    };
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerEnd);
    stage.addEventListener("pointercancel", onPointerEnd);
    stage.addEventListener("wheel", onWheel, { passive: false });
    form.addEventListener("click", onZoomClick);
    return () => {
      stage.removeEventListener("pointerdown", onPointerDown); stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerup", onPointerEnd); stage.removeEventListener("pointercancel", onPointerEnd);
      stage.removeEventListener("wheel", onWheel); form.removeEventListener("click", onZoomClick); announceEnd();
    };
  }, [stageElement, formId]);

  const videoStyle = {
    position: "absolute" as const,
    left: `${(layout.video.x / layout.canvas.width) * 100}%`, top: `${(layout.video.y / layout.canvas.height) * 100}%`,
    width: `${(layout.video.width / layout.canvas.width) * 100}%`, height: `${(layout.video.height / layout.canvas.height) * 100}%`,
    objectFit: "fill" as const, zIndex: 3,
    ...(layout.borderPx > 0 ? { outline: `${layout.borderPx * displayScale}px solid ${settings.border.colorHex}`, outlineOffset: 0 } : {}),
  };
  const logoStyle = layout.logo ? {
    position: "absolute" as const,
    left: `${(layout.logo.x / layout.canvas.width) * 100}%`, top: `${(layout.logo.y / layout.canvas.height) * 100}%`,
    width: `${(layout.logo.width / layout.canvas.width) * 100}%`, height: `${(layout.logo.height / layout.canvas.height) * 100}%`,
    opacity: settings.logo?.opacity ?? 1, objectFit: "contain" as const, zIndex: 4,
  } : undefined;

  return (
      <figure className="editor-video-preview">
      <div className="editor-comparison-control" role="group" aria-label="Compare original and edited video">
        <button type="button" aria-pressed={comparisonMode === "original"} onClick={() => {
          videoElement?.pause();
          backgroundVideoElement?.pause();
          setComparisonMode("original");
        }}>Original</button>
        <button type="button" aria-pressed={comparisonMode === "edited"} onClick={() => {
          originalVideoElement?.pause();
          setComparisonMode("edited");
        }}>Edited</button>
      </div>
      <div ref={setStageElement} className="editor-video-stage" hidden={comparisonMode !== "edited"} style={{ position: "relative", width: "100%", maxWidth: "30rem", maxHeight: "68svh", aspectRatio: `${layout.canvas.width} / ${layout.canvas.height}`, overflow: "hidden", background: settings.background.kind === "solid" ? settings.background.colorHex : "#333", border: "1px solid var(--border)", touchAction: "none", userSelect: "none" }} aria-label="Edited video preview" aria-describedby="editor-preview-gesture-help">
        {settings.background.kind === "blur" && <video ref={setBackgroundVideoElement} src={videoUrl} muted playsInline autoPlay loop aria-hidden="true" style={{ position: "absolute", inset: "-5%", width: "110%", height: "110%", objectFit: "cover", filter: `blur(${settings.background.strength * displayScale}px)`, opacity: 0.55, zIndex: 1 }} />}
        {settings.background.kind === "image" && backgroundInfo && <img src={backgroundInfo.url} alt="" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", zIndex: 1 }} />}
        {settings.background.kind === "image" && !backgroundInfo && <div role="status" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", zIndex: 1 }}>Choose an available background image.</div>}
        <video
          ref={setVideoElement} src={videoUrl} controls={false} playsInline preload="metadata" aria-label="Source video preview"
          style={videoStyle}
          onLoadStart={() => { setLoading(true); setPlaybackError(""); }}
          onLoadedMetadata={(event: { currentTarget: HTMLVideoElement }) => {
            const video = event.currentTarget; const duration = Number.isFinite(video.duration) ? video.duration : null; setActualDuration(duration);
            if (duration !== null) { const problems = trimDurationProblems(settings.trim, duration); setInvalidRange(problems.length > 0); setRangeMessage(problems[0] ?? ""); }
            const start = settings.trim.startSeconds; if (Number.isFinite(video.duration) && start < video.duration) video.currentTime = start;
          }}
          onLoadedData={() => setLoading(false)}
          onError={() => { setLoading(false); setPlaybackError("The source video could not be loaded. Check that it is still available and try again."); }}
          onTimeUpdate={(event: { currentTarget: HTMLVideoElement }) => { const video = event.currentTarget; setPlaybackTime(video.currentTime); const background = backgroundVideoElement; if (background && Math.abs(background.currentTime - video.currentTime) > 0.4) background.currentTime = video.currentTime; if (!invalidRange && video.currentTime >= trimEnd) { video.pause(); video.currentTime = trimStart; } }}
          onSeeking={(event: { currentTarget: HTMLVideoElement }) => { const video = event.currentTarget; if (invalidRange) { video.pause(); return; } if (video.currentTime < trimStart) video.currentTime = trimStart; else if (video.currentTime >= trimEnd) video.currentTime = trimStart; }}
          onPlay={(event: { currentTarget: HTMLVideoElement }) => { const video = event.currentTarget; setIsPlaying(true); if (invalidRange) { video.pause(); return; } if (video.currentTime < trimStart || video.currentTime >= trimEnd) video.currentTime = trimStart; void backgroundVideoElement?.play().catch(() => undefined); }}
          onPause={() => { setIsPlaying(false); backgroundVideoElement?.pause(); }}
        />
        {layout.logo && logoUrl && logoStyle && <img src={logoUrl} alt="" aria-hidden="true" style={logoStyle} />}
        {layout.logo && settings.logo && (
          <svg id="editor-preview" viewBox={`0 0 ${layout.canvas.width} ${layout.canvas.height}`} aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 5, overflow: "hidden" }}>
            <rect data-logo-handle data-x={settings.logo.centerX} data-y={settings.logo.centerY} x={layout.logo.x} y={layout.logo.y} width={layout.logo.width} height={layout.logo.height} fill="transparent" stroke="#ffffff" strokeWidth={Math.max(2, layout.canvas.width / 270)} strokeDasharray="12 8" style={{ cursor: "move", touchAction: "none", pointerEvents: "auto" }} />
          </svg>
        )}
      </div>
      <div className="editor-original-preview" hidden={comparisonMode !== "original"}>
        <p>Original source · editing settings are not applied</p>
        <video ref={setOriginalVideoElement} src={videoUrl} controls playsInline preload="none" aria-label="Original source video" />
      </div>
      <p id="editor-preview-gesture-help" className="muted editor-preview-gesture-help">Use two fingers to zoom and move, drag to reposition, or scroll over the preview to zoom. Page scrolling works outside the preview.</p>
      {comparisonMode === "edited" && <div className="editor-preview-playback" aria-label="Preview playback controls">
        <button type="button" disabled={invalidRange || loading || Boolean(playbackError)} aria-label={isPlaying ? "Pause preview" : "Play preview"} onClick={() => {
          const video = videoElement;
          if (!video || invalidRange) return;
          if (video.paused) void video.play().catch(() => setPlaybackError("Playback could not start in this browser. Press Play to try again."));
          else video.pause();
        }}>{isPlaying ? "Pause" : "Play"}</button>
        <label>Preview position <input type="range" min={trimStart} max={Number.isFinite(trimEnd) ? trimEnd : durationSeconds ?? trimStart + 1} step="0.01" value={Math.max(trimStart, Math.min(playbackTime, Number.isFinite(trimEnd) ? trimEnd : playbackTime))} disabled={invalidRange || loading || Boolean(playbackError)} onChange={(event: { currentTarget: HTMLInputElement }) => {
          const video = videoElement;
          if (!video) return;
          const next = Number(event.currentTarget.value);
          video.currentTime = Math.max(trimStart, Math.min(next, Number.isFinite(trimEnd) ? trimEnd : next));
          setPlaybackTime(video.currentTime);
        }} /></label>
        <output aria-label="Preview time">{playbackTime.toFixed(1)}s{Number.isFinite(trimEnd) ? ` / ${trimEnd.toFixed(1)}s` : ""}</output>
      </div>}
      <figcaption className="muted">Playback of your source video with a browser preview of the current composition. {assumedSourceSize ? "The video's dimensions are unknown, so the preview assumes 16:9. " : ""}The browser preview approximates the FFmpeg export and is not pixel-identical. {layout.canvas.width} × {layout.canvas.height} canvas.</figcaption>
      {loading && !playbackError && <p role="status">Loading video preview…</p>}
      {playbackError && <p role="alert">{playbackError}</p>}
      {invalidRange && <p role="alert">{rangeMessage || "The trim range is invalid."} Adjust the start and end times to preview this range.</p>}
      {!durationMs && actualDuration === null && <p role="note">Stored duration is unavailable; the browser will check the loaded video's duration before trim preview can be validated.</p>}
      {layout.logo && <LogoDragger svgId="editor-preview" formId={formId} />}
      <span className="sr-only">Source media {sourceId}</span>
    </figure>
  );
}
