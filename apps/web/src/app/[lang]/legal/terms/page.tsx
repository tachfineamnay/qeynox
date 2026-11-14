import type { Metadata } from 'next';
import { locale } from '../../../../lib/copy';
import { pageMetadata } from '../../../../lib/site';
import { publicCopy } from '../../../../lib/public-content';
import { LegalPage } from '../../../../components/legal-page';

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const lang = locale((await params).lang);
  const page = publicCopy[lang].legal.terms;
  return pageMetadata(lang, 'legal/terms', page.title, page.description);
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  return <LegalPage lang={lang} path="legal/terms" page={publicCopy[lang].legal.terms} />;
}
