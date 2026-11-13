import Link from 'next/link';
import { AppShell, Card } from '../../components/ui';
import { copy, locale } from '../../lib/copy';
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang); const t = copy[lang];
  return <AppShell lang={lang} active=""><section className="hero"><p className="eyebrow">{t.eyebrow}</p><h1>{t.headline}</h1><p>{t.intro}</p><Link className="button white" href={`/${lang}/mydash`}>{t.enter}<span aria-hidden="true">↗</span></Link><div className="orbit" aria-hidden="true"/></section><div className="steps">{t.steps.map((title, i) => <Card key={title}><span className="step-number">0{i + 1}</span><h2>{title}</h2><p className="muted">{t.stepCopy[i]}</p></Card>)}</div></AppShell>;
}
