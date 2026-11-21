'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Feedback } from './ui';
import { copy, type Locale } from '../lib/copy';
import { notificationCopy } from '../lib/notification-copy';
import { markAllNotificationsReadAction, markNotificationReadAction, setNotificationPreferenceAction } from '../lib/notification-actions';
import type { NotificationCategory, NotificationPreference } from '../lib/notifications';

const fmtDate = (lang: Locale, iso: string) =>
  new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso)) + ' UTC';

export { fmtDate };

/** Per-item "mark as read". Hidden once the item is read. */
export function MarkReadButton({ lang, id }: { lang: Locale; id: string }) {
  const t = copy[lang];
  const s = notificationCopy(lang);
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" className="secondary" disabled={pending} style={{ minHeight: 36, padding: '6px 12px', fontSize: 13 }}
      onClick={() => start(async () => { await markNotificationReadAction(id); router.refresh(); })}>
      {pending ? t.pending : s.markRead}
    </button>
  );
}

export function MarkAllReadButton({ lang }: { lang: Locale }) {
  const t = copy[lang];
  const s = notificationCopy(lang);
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" className="secondary" disabled={pending}
      onClick={() => start(async () => { await markAllNotificationsReadAction(); router.refresh(); })}>
      {pending ? t.pending : s.markAllRead}
    </button>
  );
}

interface PreferenceRow { readonly category: NotificationCategory; readonly label: string; readonly note: string; readonly emailEnabled: boolean }

/** Per-category e-mail opt-outs. In-app rows are always recorded; transactional e-mails are never gated. */
export function PreferencesPanel({ lang, initial }: { lang: Locale; initial: readonly NotificationPreference[] }) {
  const s = notificationCopy(lang);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<readonly PreferenceRow[]>(() => {
    const byCategory = new Map(initial.map(item => [item.category, item.emailEnabled] as const));
    return [
      { category: 'APPROVALS', label: s.approvalsLabel, note: s.approvalsNote, emailEnabled: byCategory.get('APPROVALS') ?? true },
      { category: 'EXECUTION_FAILURES', label: s.failuresLabel, note: s.failuresNote, emailEnabled: byCategory.get('EXECUTION_FAILURES') ?? true },
      { category: 'RESULTS', label: s.resultsLabel, note: s.resultsNote, emailEnabled: byCategory.get('RESULTS') ?? true },
    ];
  });
  const [failed, setFailed] = useState(false);
  const toggle = (category: NotificationCategory, emailEnabled: boolean) => {
    setRows(current => current.map(row => row.category === category ? { ...row, emailEnabled } : row));
    start(async () => {
      const result = await setNotificationPreferenceAction(category, emailEnabled);
      setFailed(result.code !== 'OK');
      router.refresh();
    });
  };
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {rows.map(row => (
        <label key={row.category} htmlFor={'pref-' + row.category} className="qx-pref-row" style={{ display: 'flex', alignItems: 'center', gap: 16, justifyContent: 'space-between', margin: 0, fontWeight: 400 }}>
          <span>
            <strong style={{ display: 'block' }}>{row.label}</strong>
            <span className="muted" style={{ fontSize: 13 }}>{row.note}</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span className="muted" style={{ fontSize: 13 }}>{s.email}</span>
            <input id={'pref-' + row.category} type="checkbox" checked={row.emailEnabled} disabled={pending}
              onChange={event => toggle(row.category, event.target.checked)}
              style={{ width: 20, height: 20 }} aria-label={row.label} />
          </span>
        </label>
      ))}
      {failed && <Feedback error title={s.saveFailed} />}
    </div>
  );
}
