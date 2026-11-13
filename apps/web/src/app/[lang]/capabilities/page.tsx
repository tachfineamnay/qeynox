import { AppShell, CapabilityAvailability } from '../../../components/ui';
import { copy, locale } from '../../../lib/copy';
export default async function Page({ params }: { params: Promise<{ lang: string }> }) { const lang = locale((await params).lang); return <AppShell lang={lang} active="capabilities"><h1>{copy[lang].capabilities}</h1><CapabilityAvailability lang={lang}/></AppShell>; }
