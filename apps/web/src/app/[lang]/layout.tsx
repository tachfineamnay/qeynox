import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SITE_NAME, SITE_URL } from '../../lib/site';
import '../globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME,
  title: { default: 'QeyNox — Results as a Service', template: '%s' },
  description: 'Business objectives, governed work and evidence-backed deliverables. No promise of business or financial success.',
};

export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (lang !== 'en' && lang !== 'fr') notFound();
  return <html lang={lang}><body>{children}</body></html>;
}
