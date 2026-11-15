"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "./format.ts";

export function UploadedAt({ createdAt }: { createdAt: Date | null | undefined }) {
  const iso = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : null;
  const [display, setDisplay] = useState(() => iso ? `${formatDateTime(new Date(iso), "UTC")} UTC` : "Unavailable");
  const [isLocal, setIsLocal] = useState(false);

  useEffect(() => {
    if (!iso) return;
    const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    setDisplay(formatDateTime(new Date(iso), browserTimeZone));
    setIsLocal(true);
  }, [iso]);

  if (!iso) return <span className="media-uploaded-time-unavailable">Unavailable</span>;
  return <time dateTime={iso} title={isLocal ? "Displayed in your local timezone" : "Converting UTC to your local timezone"}>{display}</time>;
}
