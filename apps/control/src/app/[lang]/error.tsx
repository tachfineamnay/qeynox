'use client';
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main style={{ padding: 32 }}>
      <h1>QeyNox Control</h1>
      <p>The requested control screen could not be rendered. The platform API may be unavailable or the session expired.<br />
        L'écran demandé n'a pas pu être rendu. L'API plateforme peut être indisponible ou la session expirée.</p>
      <button type="button" onClick={reset}>Retry / Réessayer</button>
    </main>
  );
}
