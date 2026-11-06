/** User-facing render failures. Never includes a file path or an FFmpeg command. */

export function publicRenderFailure(problems: string[]): string {
  const text = problems.join(" ");
  if (text.includes("not available")) return "FFmpeg is not available on this server. No export was saved.";
  if (text.includes("took too long")) return "Rendering took too long and was stopped. The original video was not changed.";
  if (text.includes("Unexpected video codec") || text.includes("Output is ") || text.includes("Output lasts")) return "The finished file did not match the expected picture, so it was not saved. The original video was not changed.";
  return "Rendering failed before a finished file was saved. The original video was not changed.";
}

/** Server-side note with directories removed, so a failure can be investigated without revealing storage paths. */
export function renderDiagnostic(problems: string[]): string {
  return problems.join(" ").replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\s'"]+/g, "[path]").slice(0, 240);
}
