'use client';
import { useParams } from 'next/navigation';
import { copy, locale } from '../../lib/copy';
export default function ErrorPage({ reset }: { reset: () => void }) { const params = useParams(); const t = copy[locale(String(params.lang))]; return <main><div className="feedback error" role="alert"><h1>{t.error}</h1><button onClick={reset}>{t.retry}</button></div></main>; }
