"use client";

import { useEffect, useMemo, useState } from "react";
import { applySettingsPatch, parseBulkForm } from "../lib/domain/bulk-edit.ts";
import { DEFAULT_EDITING_SETTINGS, parseEditingSettings, type EditingSettings } from "../lib/domain/editing-settings.ts";
import type { MaxResolution } from "../lib/render/ffmpeg-command.ts";
import type { MediaCard } from "../server/queries.ts";
import { EditorVideoPreview } from "./EditorVideoPreview.tsx";

type PreviewVideo = MediaCard & { settings?: EditingSettings };
type PreviewTemplate = { id: string; name: string; settings?: EditingSettings };

const fileUrl = (id: string) => `/api/media/file?id=${encodeURIComponent(id)}&variant=preview`;

/** Read-only browser composition preview; it never submits the bulk form or starts a render. */
export function BulkLivePreview({ videos, images, templates, maxResolution, formId }: {
  videos: PreviewVideo[];
  images: MediaCard[];
  templates: PreviewTemplate[];
  maxResolution: MaxResolution;
  formId: string;
}) {
  const [videoId, setVideoId] = useState(videos[0]?.id ?? "");
  const [settings, setSettings] = useState<EditingSettings>(videos[0]?.settings ?? DEFAULT_EDITING_SETTINGS);
  const [previewNotice, setPreviewNotice] = useState("");
  const videoById = useMemo(() => new Map(videos.map((video) => [video.id, video])), [videos]);
  const selected = videoById.get(videoId) ?? videos[0];

  useEffect(() => {
    const current = selected;
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!current || !form) return;

    const update = () => {
      const data = new FormData(form);
      const value = (key: string): string | undefined => {
        const entry = data.get(key);
        return typeof entry === "string" ? entry : undefined;
      };
      const parsed = parseBulkForm(value, (key) => data.getAll(key).filter((entry): entry is string => typeof entry === "string"));
      if (!parsed.ok) {
        // An empty or currently invalid form previews the selected video's saved settings.
        setSettings(current.settings ?? DEFAULT_EDITING_SETTINGS);
        setPreviewNotice(parsed.problems[0] ?? "Choose a template or a setting to preview changes.");
        return;
      }

      if (parsed.styleTemplateId) {
        const template = templates.find((item) => item.id === parsed.styleTemplateId);
        if (!template?.settings) {
          setSettings(current.settings ?? DEFAULT_EDITING_SETTINGS);
          setPreviewNotice("This saved template could not be previewed.");
          return;
        }
        const candidate = { ...template.settings, trim: parsed.copyTemplateTrim ? template.settings.trim : (current.settings ?? DEFAULT_EDITING_SETTINGS).trim };
        const safe = parseEditingSettings(candidate);
        if (!safe.ok) {
          setSettings(current.settings ?? DEFAULT_EDITING_SETTINGS);
          setPreviewNotice("This template has settings that cannot be previewed.");
          return;
        }
        setSettings(safe.settings);
        setPreviewNotice(`Previewing “${template.name}” on ${current.title}.`);
        return;
      }

      const candidate = applySettingsPatch(current.settings ?? DEFAULT_EDITING_SETTINGS, parsed.patch).settings;
      const safe = parseEditingSettings(candidate);
      if (!safe.ok) {
        setPreviewNotice(safe.problems[0] ?? "These settings cannot be previewed yet.");
        return;
      }
      setSettings(safe.settings);
      setPreviewNotice(`Previewing selected settings on ${current.title}.`);
    };

    update();
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    return () => {
      form.removeEventListener("input", update);
      form.removeEventListener("change", update);
    };
  }, [formId, selected, templates]);

  useEffect(() => {
    if (!videoById.has(videoId) && videos[0]) setVideoId(videos[0].id);
  }, [videoById, videoId, videos]);

  if (!selected) return null;

  return (
    <section className="bulk-live-preview" aria-labelledby="bulk-live-preview-heading">
      <div className="bulk-live-preview-header">
        <div><p className="bulk-editor-eyebrow">LIVE PREVIEW</p><h2 id="bulk-live-preview-heading">See your changes</h2><p>Preview one selected video while you adjust the batch. Original files stay unchanged.</p></div>
        <label htmlFor="bulk-preview-video">Preview video
          <select id="bulk-preview-video" value={selected.id} onChange={(event: { currentTarget: HTMLSelectElement }) => setVideoId(event.currentTarget.value)}>
            {videos.map((video) => <option key={video.id} value={video.id}>{video.title}</option>)}
          </select>
        </label>
      </div>
      <EditorVideoPreview
        videoUrl={fileUrl(selected.id)}
        sourceId={selected.id}
        sourceWidth={selected.width ?? null}
        sourceHeight={selected.height ?? null}
        durationMs={selected.durationMs ?? null}
        assumedSourceSize={!selected.width || !selected.height}
        settings={settings}
        controlledSettings={settings}
        maxResolution={maxResolution}
        formId="bulk-live-preview-no-associated-editor-form"
        images={images.map((image) => ({ id: image.id, url: fileUrl(image.id), width: image.width ?? null, height: image.height ?? null }))}
      />
      <p className="bulk-live-preview-status" role="status" aria-live="polite">{previewNotice || "Choose a template or enable a setting to preview it here."}</p>
      <p className="bulk-live-preview-disclaimer">This is a browser preview of the composition, not a rendered export. Use “Review changes” to continue; nothing is saved from this preview.</p>
    </section>
  );
}
