import { notFound } from 'next/navigation';
import '../globals.css';
export const metadata = { title: 'QeyNox — Results as a Service', description: 'Business objectives, governed work and evidence-backed deliverables.' };
export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) { const { lang } = await params; if (lang !== 'en' && lang !== 'fr') notFound(); return <html lang={lang}><body>{children}</body></html>; }
