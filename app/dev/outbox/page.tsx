import { notFound } from "next/navigation.js";

export const metadata = { title: "Dev outbox", robots: { index: false } };
export const dynamic = "force-dynamic";

// Local outbox data can contain single-use account verification and password-reset links.
// Keep the backend mail sink for tests, but do not expose the messages through a customer route.
export default function DevOutboxPage(): never { notFound(); }
