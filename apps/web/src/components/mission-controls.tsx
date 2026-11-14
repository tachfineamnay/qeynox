'use client';
import { useActionState, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { change } from '../lib/mission-actions';
import { missionCopy } from '../lib/mission-copy';
import type { Locale } from '../lib/copy';
import { errorText } from './forms';
import { Feedback } from './ui';
export function ChangeForm({ lang, fields, label, children }: { lang: Locale; fields: Record<string,string>; label: string; children?: React.ReactNode }) {
  const [state, action, pending] = useActionState(change, { code: '' });
  const t = missionCopy(lang);
  return <form action={action} className="change-form">{Object.entries(fields).map(([name,value]) => <input key={name} type="hidden" name={name} value={value}/>)}{children}<button disabled={pending}>{pending ? t.busy : label}</button>{state.code && <Feedback title={state.code === 'OK' ? t.success : `${errorText(state.code, lang)} (${state.code})`} error={state.code !== 'OK'}/>} {state.consentId && <p>{t.consent}: <code>{state.consentId}</code></p>}</form>;
}
export function ExportForm({ lang, operationId, documentId, format }: { lang: Locale; operationId: string; documentId: string; format: 'json'|'html' }) {
  const [state, action, pending] = useActionState(change, { code: '' }); const t = missionCopy(lang);
  return <form action={action} className="change-form"><input type="hidden" name="kind" value={state.artifactId ? 'renew' : 'export'}/><input type="hidden" name="operationId" value={operationId}/><input type="hidden" name="documentId" value={documentId}/><input type="hidden" name="format" value={format}/>{state.artifactId && <input type="hidden" name="artifactId" value={state.artifactId}/>}<button disabled={pending}>{pending ? t.busy : `${state.artifactId ? t.renew : t.export} · ${format.toUpperCase()}`}</button>{state.url && <a href={state.url} target="_blank" rel="noopener noreferrer">{t.download}</a>}{state.sha256 && <p className="muted">{missionCopy(lang).flow.exportDigest}: <code>{state.sha256}</code></p>}{state.code && state.code !== 'OK' && <Feedback title={`${errorText(state.code, lang)} (${state.code})`} error/>}</form>;
}
export function RefreshMission({ active, lang }: { active: boolean; lang: Locale }) {
  const router = useRouter(); const [pending, start] = useTransition();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (!document.hidden && !document.activeElement?.closest('form') && !pending) start(() => router.refresh()); }, 10000);
    return () => clearInterval(timer);
  }, [active, pending, router]);
  return <button className="secondary" disabled={pending} onClick={() => start(() => router.refresh())}>{missionCopy(lang).refresh}</button>;
}
