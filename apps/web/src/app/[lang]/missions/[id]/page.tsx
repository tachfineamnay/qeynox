import Link from 'next/link';
import { idSchema } from '@qeynox/contracts';
import { AppShell, Card, Feedback, StatusBadge } from '../../../../components/ui';
import { api, operationSchema } from '../../../../lib/api';
import { copy, locale } from '../../../../lib/copy';
export default async function Page({ params }: { params: Promise<{ lang: string; id: string }> }) {
  const p = await params; const lang = locale(p.lang); const t = copy[lang]; let operation;
  try { const id = idSchema.parse(p.id); operation = operationSchema.parse(await api(`/v1/operations/${encodeURIComponent(id)}`)); } catch { /* No local substitute for canonical state. */ }
  return <AppShell lang={lang} active="missions"><Link href={`/${lang}/mydash`}>← {t.back}</Link><header className="page-intro"><p className="eyebrow">{t.detail}</p><h1>{operation?.title ?? t.missing}</h1>{operation && <StatusBadge status={operation.status} lang={lang}/>}</header><Card><Feedback title={operation ? t.blocked : t.missing} error={!operation}>{t.blockedCopy}</Feedback></Card></AppShell>;
}
