export default function NotFound() {
  return (
    <section className="not-found-page">
      <div className="not-found-card">
        <span className="not-found-code">404</span>
        <h1>We couldn’t find that page</h1>
        <p>The link may be out of date, or the page may have moved.</p>
        <div><a className="not-found-primary" href="/dashboard">Open workspace</a><a className="not-found-secondary" href="/">Go to ClipForge home</a></div>
      </div>
    </section>
  );
}
