export default function CycleDetailLoading() {
  return (
    <section className="cycle-detail-page cycles-skeleton" aria-label="Loading cycle details" aria-busy="true">
      <div className="cycles-skeleton-line" />
      <div className="cycles-skeleton-line cycles-skeleton-line-lg" />
      <div className="cycles-skeleton-grid" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => <div className="cycles-skeleton-card" key={index} />)}
      </div>
      <div className="cycles-skeleton-card" aria-hidden="true" />
    </section>
  );
}
