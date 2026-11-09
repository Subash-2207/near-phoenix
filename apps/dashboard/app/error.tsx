"use client";
export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="error-page">
      <p className="eyebrow">PHOENIX COMMAND CENTER</p>
      <h1>The workspace could not be loaded.</h1>
      <p role="alert">
        An interface error interrupted this view. Reload the workspace to
        reconnect to telemetry.
      </p>
      <button className="button button-primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
