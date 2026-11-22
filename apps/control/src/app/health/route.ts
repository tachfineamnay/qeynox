export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json({ status: 'alive', release: { sha: process.env.QEYNOX_RELEASE_SHA ?? null, version: process.env.QEYNOX_RELEASE_VERSION ?? null } }, { headers: { 'cache-control': 'no-store' } });
}
