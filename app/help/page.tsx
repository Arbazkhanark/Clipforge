import { PublicPage } from "../../src/components/PublicPage.tsx";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "Help and FAQs", description: "Answers about ClipForge plans, Instagram connection, publishing status and collection sharing.", path: "/help" });

const faqs = [
  ["What is ClipForge?", "ClipForge is a workspace for organizing short-form video, applying edits, preparing campaigns and tracking stored publishing states."],
  ["Which plans are available?", "Free, Creator, Pro and Agency plans are listed from the central plan catalog. Check the Pricing page for current catalog prices and limits."],
  ["How does Instagram connection work?", "ClipForge uses official Meta authorization for eligible Instagram professional accounts. It does not ask for your Instagram password. Connection and publishing depend on permissions and server configuration."],
  ["What if a publishing attempt fails?", "Definite failures and uncertain outcomes are represented separately. An ambiguous result stays in manual review; ClipForge does not blindly retry a publish that may have succeeded."],
  ["How does video sharing work?", "Collection owners grant specific permissions. A shared reference keeps the source owner's ownership. Importing a copy is a separate action subject to permission and availability checks."],
  ["Can I get help or submit feedback?", "A public support address and feedback form are not configured in this build. The Contact page explains this limitation rather than listing an unverified address."],
] as const;

export default function HelpPage() {
  return <PublicPage eyebrow="Help center" title="Answers before you start." intro="These answers describe current ClipForge behavior and its limits.">
    <div className="faq-list">{faqs.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div>
    <p className="notice">For provider-dependent features, the account and deployment must meet the current requirements. ClipForge does not guarantee publishing, reach or results.</p>
  </PublicPage>;
}
