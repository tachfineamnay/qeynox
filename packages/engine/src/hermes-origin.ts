export function hermesEndpoint(value: string, privateOrigin?: string): string {
  const base = new URL(value);
  if (base.username || base.password || base.search || base.hash) throw new Error('Invalid Hermes base URL');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && (
    ['localhost', '127.0.0.1', 'hermes', 'hermes-gateway'].includes(base.hostname) ||
    (privateOrigin && new URL(privateOrigin).origin === privateOrigin && base.origin === privateOrigin)
  ))) throw new Error('Hermes origin not authorized');
  return new URL('chat/completions', base.href.endsWith('/') ? base.href : base.href + '/').href;
}
