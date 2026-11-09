import type { ReactNode } from "react";

/** Admin pages are kept out of search indexes; authorization is enforced separately by the protected route group. */
export const metadata = {
  title: { default: "Super Admin", template: "%s | ClipForge Admin" },
  robots: { index: false, follow: false },
};

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return children;
}
