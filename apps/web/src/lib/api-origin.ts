/** Explicit server-only origin authorization. Never derive it from browser input. */
export function apiOrigin(value: string | undefined, privateOrigin?: string): string {
  if (!value) throw new Error('API origin required');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid API origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    (privateOrigin && new URL(privateOrigin).origin === privateOrigin && url.origin === privateOrigin)
  ))) throw new Error('API origin not authorized');
  return url.href;
}
