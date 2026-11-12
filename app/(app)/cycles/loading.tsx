export default function CyclesLoading() {
  return (
    <section className="cycles-page cycles-skeleton" aria-label="Loading publishing cycles" aria-busy="true">
      <div className="cycles-skeleton-line cycles-skeleton-line-lg" />
      <div className="cycles-skeleton-line" />
      <div className="cycles-skeleton-grid" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => <div className="cycles-skeleton-card" key={index} />)}
      </div>
      <div className="cycles-skeleton-card" aria-hidden="true" />
    </section>
  );
}
