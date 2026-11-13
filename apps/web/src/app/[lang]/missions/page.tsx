import { Workspace } from '../../../components/workspace';
import { locale } from '../../../lib/copy';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ lang: string }> }) { return <Workspace lang={locale((await params).lang)} listOnly/>; }
