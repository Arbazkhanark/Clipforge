import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminPreviewPage } from "../../components/admin/AdminPreviewPage.tsx";
import { ADMIN_PREVIEW_PAGES } from "./admin-preview-data.ts";

export const ADMIN_PREVIEW_HOST = "127.0.0.1";
export const ADMIN_PREVIEW_PORT = 4177;

export function assertAdminPreviewAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === "production") throw new Error("Admin preview is disabled in production.");
}

export function renderAdminPreviewDocument(pathname: string): string | null {
  const data = ADMIN_PREVIEW_PAGES[pathname] ?? null;
  if (!data) return null;
  const body = renderToStaticMarkup(createElement(AdminPreviewPage, { pathname, data }));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(data.title)} · Synthetic Admin Preview</title><link rel="stylesheet" href="/globals.css"><link rel="stylesheet" href="/preview.css"></head><body>${body}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] as string);
}
