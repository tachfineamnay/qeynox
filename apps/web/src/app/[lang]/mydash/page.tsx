import { Workspace } from '../../../components/workspace';
import { locale } from '../../../lib/copy';

import type { Metadata } from 'next';

/** MISSION A03 — authenticated product surface: never indexed (robots.txt also disallows it). */
export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ lang: string }> }) { return <Workspace lang={locale((await params).lang)}/>; }
