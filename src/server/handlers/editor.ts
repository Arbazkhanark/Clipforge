// Saving editing settings as a template. The settings are separate from media: this handler never reads, changes
// or copies an original file. A logo is referenced by the id of one of the user's own images.
import { getPlan } from "../../lib/billing/catalog.ts";
import { parseEditingSettings } from "../../lib/domain/editing-settings.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { planLimit, validationFailed } from "../errors.ts";
import { Problems, readObject, readText } from "../validation.ts";

export async function saveEditingTemplate(ctx: RequestContext, rawInput: unknown): Promise<{ templateId: string }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const name = readText(input, "name", problems, { min: 1, max: 100 }).trim();
  if (name === "") problems.add("name must not be blank.");
  problems.throwIfAny();

  const parsed = parseEditingSettings(input["settings"]);
  if (!parsed.ok) throw validationFailed(parsed.problems);
  const { settings } = parsed;

  if (settings.logo) {
    const logoMedia = await ctx.repo.getMedia(settings.logo.mediaId);
    if (!logoMedia || logoMedia.ownerId !== userId || logoMedia.status !== "active" || (logoMedia.kind ?? "video") !== "image") throw validationFailed(["The logo must be one of your own images."]);
  }

  const planId = await ctx.repo.getPlanIdForUser(userId);
  const limit = getPlan(planId).limits.templates;
  const templateId = ctx.newId();
  if (!(await ctx.repo.createTemplateIfWithinLimit({ id: templateId, ownerId: userId, name, settings, createdAt: ctx.now }, limit))) {
    throw planLimit(`Your plan allows ${limit} saved template${limit === 1 ? "" : "s"}. Delete one or upgrade to save more.`);
  }
  await ctx.repo.appendAudit({ actorId: userId, action: "template.created", entityType: "EditingTemplate", entityId: templateId, metadata: { aspect: settings.aspect, hasLogo: settings.logo !== null } });
  return { templateId };
}
