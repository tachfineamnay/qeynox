export default function Loading() {
  // Textual state, not just placeholder bars: visible to everyone, announced via role=status.
  return <div className="loading" role="status" aria-label="Loading / Chargement"><div className="skeleton" aria-hidden="true" /><div className="skeleton" aria-hidden="true" /><div className="skeleton" aria-hidden="true" /><p className="loading-caption">Loading… / Chargement…</p></div>;
}
