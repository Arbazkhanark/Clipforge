export const metadata = { title: "Home" };

// Honest landing copy: no testimonials, no customer counts, no unbuilt integration badges.
export default function HomePage() {
  return (
    <>
      <h1>Prepare, organise and schedule short-form video</h1>
      <p>ClipForge is being built for creators and clipping teams who manage videos for several brands and clients.</p>
      <p role="note" className="notice">Early development: sign-in, uploads and publishing are not available yet. This page describes what is planned.</p>
      <h2>Planned</h2>
      <ul>
        <li>Collections that keep each client's videos separate</li>
        <li>Sharing collections, and using a shared video without copying it</li>
        <li>A video editor with templates</li>
        <li>Publishing cycles with a schedule, for Instagram first</li>
      </ul>
      <p><a href="/pricing">See planned plans and prices</a></p>
    </>
  );
}
