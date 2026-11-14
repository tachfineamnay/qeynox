import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import '../globals.css';

export const metadata: Metadata = {
  title: 'QeyNox Control',
  description: 'QeyNox platform administration desk',
};

export default async function LangLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (lang !== 'en' && lang !== 'fr') notFound();
  return <html lang={lang}><body>{children}</body></html>;
}
