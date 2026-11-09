// Saving editing settings as a template. The settings are separate from media: this handler never reads, changes
// or copies an original file. A logo is referenced by the id of one of the user's own images.
import { getPlan } from "../../lib/billing/catalog.ts";
import { isReservedTemplateName, parseEditingSettings, trimDurationProblems, videoSettingsName } from "../../lib/domain/editing-settings.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { notFound, planLimit, validationFailed } from "../errors.ts";
import { Problems, readObject, readText } from "../validation.ts";

export async function saveEditingTemplate(ctx: RequestContext, rawInput: unknown): Promise<{ templateId: string; created: boolean }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const name = readText(input, "name", problems, { min: 1, max: 100 }).trim();
  if (name === "") problems.add("name must not be blank.");
  if (isReservedTemplateName(name)) problems.add("That template name is reserved.");
  problems.throwIfAny();

  const parsed = parseEditingSettings(input["settings"]);
  if (!parsed.ok) throw validationFailed(parsed.problems);
  const { settings } = parsed;

  if (settings.logo) {
    const logoMedia = await ctx.repo.getMedia(settings.logo.mediaId);
    if (!logoMedia || logoMedia.ownerId !== userId || logoMedia.status !== "active" || (logoMedia.kind ?? "video") !== "image") throw validationFailed(["The logo must be one of your own images."]);
  }

  const existing = (await ctx.repo.listTemplatesForOwner(userId)).find((template) => !isReservedTemplateName(template.name) && template.name === name && JSON.stringify(template.settings) === JSON.stringify(settings));
  if (existing) return { templateId: existing.id, created: false };
  const planId = await ctx.repo.getPlanIdForUser(userId, ctx.now);
  const limit = getPlan(planId).limits.templates;
  const templateId = ctx.newId();
  if (!(await ctx.repo.createTemplateIfWithinLimit({ id: templateId, ownerId: userId, name, settings, createdAt: ctx.now }, limit))) {
    throw planLimit(`Your plan allows ${limit} saved template${limit === 1 ? "" : "s"}. Delete one or upgrade to save more.`);
  }
  await ctx.repo.appendAudit({ actorId: userId, action: "template.created", entityType: "EditingTemplate", entityId: templateId, metadata: { aspect: settings.aspect, hasLogo: settings.logo !== null } });
  return { templateId, created: true };
}

/** Persists the editor form onto one owned video. The original file is not changed. */
export async function saveCurrentVideoSettings(ctx: RequestContext, rawInput: unknown): Promise<{ mediaId: string }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const mediaId = readText(input, "mediaId", problems, { min: 1, max: 64 });
  problems.throwIfAny();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(mediaId)) throw validationFailed(["Choose a video."]);
  const parsed = parseEditingSettings(input["settings"]);
  if (!parsed.ok) throw validationFailed(parsed.problems);
  const media = await ctx.repo.getMedia(mediaId);
  if (!media || media.ownerId !== userId || media.status !== "active" || (media.kind ?? "video") !== "video") throw notFound("Video");
  const trimProblems = trimDurationProblems(parsed.settings.trim, (media.durationMs ?? 0) / 1000);
  if (trimProblems.length > 0) throw validationFailed(trimProblems);
  if (parsed.settings.logo) {
    const logo = await ctx.repo.getMedia(parsed.settings.logo.mediaId);
    if (!logo || logo.ownerId !== userId || logo.status !== "active" || logo.kind !== "image") throw validationFailed(["The logo must be one of your own images."]);
  }
  if (parsed.settings.background.kind === "image") {
    const image = await ctx.repo.getMedia(parsed.settings.background.mediaId);
    if (!image || image.ownerId !== userId || image.status !== "active" || image.kind !== "image") throw validationFailed(["The background image must be one of your own images."]);
  }
  await ctx.repo.saveVideoSettings({ id: ctx.newId(), ownerId: userId, name: videoSettingsName(mediaId), settings: parsed.settings, createdAt: ctx.now });
  await ctx.repo.appendAudit({ actorId: userId, action: "editor.saved", entityType: "MediaAsset", entityId: mediaId, metadata: { aspect: parsed.settings.aspect } });
  return { mediaId };
}
