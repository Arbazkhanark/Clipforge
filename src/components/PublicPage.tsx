import type { ReactNode } from "react";

export function PublicPage({ eyebrow, title, intro, children }: { eyebrow?: string; title: string; intro?: string; children: ReactNode }) {
  return <article className="public-page"><header className="public-page-heading">{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{intro && <p className="public-page-intro">{intro}</p>}</header><div className="public-page-body">{children}</div></article>;
}
