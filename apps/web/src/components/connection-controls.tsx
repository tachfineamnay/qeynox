'use client';
import { useActionState } from 'react';
import { connectionCopy } from '../lib/connection-copy';
import { connectAction, disconnectAction, refreshConnectionAction, type ConnectState, type DisconnectState } from '../lib/connection-actions';
import { errorText } from './forms';
import { Feedback } from './ui';

const idle: ConnectState = { code: '' };

/** Connect / reconnect button. Disabled with reasons handled by the parent when NOT_CONFIGURED. */
export function ConnectButton({ lang, provider, label, disabled }: { lang: 'en' | 'fr'; provider: string; label: string; disabled?: boolean }) {
  const [state, action, pending] = useActionState(connectAction, idle);
  return (
    <form action={action}>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="provider" value={provider} />
      <button type="submit" disabled={disabled || pending}>{pending ? connectionCopy(lang).working : label}</button>
      {state.code ? <Feedback error title={errorText(state.code, lang)} /> : null}
    </form>
  );
}

/** Manual repair path for ERROR / EXPIRED connections. */
export function RefreshButton({ lang, provider, label, disabled }: { lang: 'en' | 'fr'; provider: string; label: string; disabled?: boolean }) {
  const [state, action, pending] = useActionState(refreshConnectionAction, idle);
  return (
    <form action={action}>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="provider" value={provider} />
      <button type="submit" className="button secondary" disabled={disabled || pending}>{pending ? connectionCopy(lang).working : label}</button>
      {state.code ? <Feedback error title={errorText(state.code, lang)} /> : null}
    </form>
  );
}

const disconnectIdle: DisconnectState = { code: '' };
export function DisconnectButton({ lang, provider, label, disabled }: { lang: 'en' | 'fr'; provider: string; label: string; disabled?: boolean }) {
  const [state, action, pending] = useActionState(disconnectAction, disconnectIdle);
  return (
    <form action={action}>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="provider" value={provider} />
      <button type="submit" className="button danger" disabled={disabled || pending}>{pending ? connectionCopy(lang).working : label}</button>
      {state.code ? <Feedback error title={errorText(state.code, lang)} /> : null}
    </form>
  );
}
