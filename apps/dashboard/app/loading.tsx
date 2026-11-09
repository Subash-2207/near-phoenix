export default function Loading() {
  return (
    <main
      className="loading-page"
      aria-busy="true"
      aria-label="Loading PHOENIX"
    >
      <p className="eyebrow">PHOENIX COMMAND CENTER</p>
      <h1>Opening your workspace.</h1>
      <div className="metric-grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="metric-card">
            <div className="skeleton metric-skeleton" />
          </div>
        ))}
      </div>
    </main>
  );
}
