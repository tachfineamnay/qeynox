import type { ReactNode } from 'react';
import type { Locale } from '../lib/copy';
import { betaCopy } from '../lib/beta-copy';
import type { BetaJourney, BetaJourneyRead } from '../lib/beta';
import { formatMoney } from '../lib/money';
import { BetaActivateForm } from './beta-activate-form';

/**
 * MISSION A21.04 — the free-beta customer journey, rendered from the server's journey read model only.
 *
 * Nothing here decides entitlement: the state, the waiver, the allowance and the expiry are the API's.
 * Every status carries a text label and a glyph, never colour alone (WCAG 2.2 AA).
 */

type Tone = 'success' | 'neutral' | 'warning' | 'danger';
const stateTone: Record<BetaJourney['state'], Tone> = {
  ACTIVE: 'success',
  NOT_CONFIGURED: 'neutral',
  NOT_ENROLLED: 'neutral',
  INVITATION_PENDING: 'warning',
  QUOTA_EXHAUSTED: 'warning',
  CONCURRENT_LIMIT_REACHED: 'warning',
  RUNTIME_UNAVAILABLE: 'warning',
  EXPIRED: 'danger',
  REVOKED: 'danger',
};
const accountTone: Record<BetaJourney['account']['status'], Tone> = { ACTIVE: 'success', INVITED: 'warning', NOT_ENROLLED: 'neutral', EXPIRED: 'danger', REVOKED: 'danger' };
const glyph: Record<Tone, string> = { success: '✓', neutral: 'i', warning: '!', danger: '×' };

export function betaDate(lang: Locale, value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(lang, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC'
    : '—';
}

/** Amount due today: always zero (payments are frozen); formatted in the price's or the grant's currency. */
function dueToday(lang: Locale, journey: BetaJourney | null, currency: string | null): string {
  const unit = currency ?? journey?.account.currency ?? null;
  return unit ? formatMoney(0, unit, lang) : new Intl.NumberFormat(lang).format(0);
}

function stateText(lang: Locale, journey: BetaJourney) {
  const c = betaCopy(lang);
  if (journey.state === 'QUOTA_EXHAUSTED' && journey.account.quotaReason === 'PROVIDER_BUDGET') return c.quotaBudget;
  return c.states[journey.state] ?? { title: journey.state, body: '' };
}

/** One server-derived state, stated plainly. `hideActive` keeps compact contexts quiet when all is well. */
export function BetaStateNotice({ lang, read, hideActive = false, compact = false }: { lang: Locale; read: BetaJourneyRead; hideActive?: boolean; compact?: boolean }) {
  const c = betaCopy(lang);
  if (!read.journey) {
    const text = c.unavailable(read.code);
    return (
      <div className="qx-beta-notice" data-tone="danger" data-beta-state="UNAVAILABLE" role="status">
        <span className="qx-beta-glyph" aria-hidden="true">{glyph.danger}</span>
        <div><strong>{text.title}</strong>{compact ? null : <p>{text.body}</p>}</div>
      </div>
    );
  }
  const journey = read.journey;
  if (hideActive && journey.state === 'ACTIVE') return null;
  const tone = stateTone[journey.state];
  const text = stateText(lang, journey);
  return (
    <div className="qx-beta-notice" data-tone={tone} data-beta-state={journey.state} role="status">
      <span className="qx-beta-glyph" aria-hidden="true">{glyph[tone]}</span>
      <div><strong>{text.title}</strong>{compact ? null : <p>{text.body}</p>}</div>
    </div>
  );
}

export function BetaAccountTag({ lang, journey }: { lang: Locale; journey: BetaJourney }) {
  const c = betaCopy(lang);
  const tone = accountTone[journey.account.status];
  return <span className={'badge ' + tone} data-beta-account={journey.account.status}><span aria-hidden="true">{glyph[tone]} </span>{c.accountStatus[journey.account.status]}</span>;
}

export interface BetaPrice { amountMinor: number; currency: string; isExplicitlyFree?: boolean }

/**
 * Compact price for catalogue cards: the list price, crossed through only when the server says the
 * 100% waiver applies to this workspace, plus the nothing-due-today line.
 */
export function BetaPriceTag({ lang, read, price }: { lang: Locale; read: BetaJourneyRead; price: BetaPrice }) {
  const c = betaCopy(lang);
  const journey = read.journey;
  const list = formatMoney(price.amountMinor, price.currency, lang);
  const free = price.amountMinor === 0;
  const waived = Boolean(journey?.freeBeta.waiverApplies) && !free;
  return (
    <div className="qx-beta-price" data-waived={waived ? 'true' : 'false'}>
      {free ? <span className="badge success">{c.noListPrice}</span> : waived
        ? <span className="qx-price"><span className="qx-sr-only">{c.listPriceWaivedSr} </span><s>{list}</s> <strong>{dueToday(lang, journey, price.currency)}</strong></span>
        : <span className="qx-price"><strong>{list}</strong></span>}
      {journey?.freeBeta.enabled ? <span className="qx-beta-chip">{c.catalogueBadge}</span> : null}
    </div>
  );
}

type SummaryContext = 'service' | 'quote' | 'launch' | 'payment';

/**
 * The beta offer summary: free beta / no card, list price, the labelled 100% waiver, 0 due today,
 * the remaining allowance, the expiry and the account status — then the state notice when anything
 * blocks. Used on the service detail, quote acceptance, launch and in place of the payment panel.
 */
export function BetaOfferSummary({ lang, read, price, context, children }: { lang: Locale; read: BetaJourneyRead; price: BetaPrice | null; context: SummaryContext; children?: ReactNode }) {
  const c = betaCopy(lang);
  const journey = read.journey;
  if (!journey) {
    return (
      <section className="qx-beta-offer" data-context={context} aria-label={c.eyebrow}>
        <BetaStateNotice lang={lang} read={read} />
        <p className="muted">{c.frozenNote}</p>
        {children}
      </section>
    );
  }
  const enabled = journey.freeBeta.enabled;
  const priced = price !== null && price.amountMinor > 0;
  const waived = journey.freeBeta.waiverApplies && priced;
  const a = journey.account;
  const note = context === 'launch' ? c.launchNote : context === 'quote' ? c.acceptNote : context === 'payment' ? c.paymentReplaced : null;
  return (
    <section className="qx-beta-offer" data-context={context} data-beta-state={journey.state} aria-label={c.eyebrow}>
      <p className="qx-beta-headline"><span aria-hidden="true">◆ </span>{enabled ? c.headline : c.headlineDisabled}</p>
      <dl className="qx-beta-facts">
        {price ? (
          <div>
            <dt>{c.listPrice}</dt>
            <dd>{!priced ? c.noListPrice : waived
              ? <><span className="qx-sr-only">{c.listPriceWaivedSr} </span><s>{formatMoney(price.amountMinor, price.currency, lang)}</s></>
              : formatMoney(price.amountMinor, price.currency, lang)}</dd>
          </div>
        ) : null}
        {waived && price ? (
          <div data-beta-waiver="true"><dt>{c.waiver}</dt><dd>−{formatMoney(price.amountMinor, price.currency, lang)}</dd></div>
        ) : null}
        <div className="qx-beta-due"><dt>{c.dueToday}</dt><dd><strong>{dueToday(lang, journey, price?.currency ?? null)}</strong></dd></div>
        {a.missionQuota !== null && a.missionsRemaining !== null ? (
          <div><dt>{c.remaining}</dt><dd>{c.remainingValue(a.missionsRemaining, a.missionQuota)}</dd></div>
        ) : null}
        {a.status === 'INVITED'
          ? <div><dt>{c.invitationExpires}</dt><dd>{betaDate(lang, a.invitationExpiresAt)}</dd></div>
          : a.expiresAt ? <div><dt>{c.expires}</dt><dd>{betaDate(lang, a.expiresAt)}</dd></div> : null}
        <div><dt>{c.status}</dt><dd><BetaAccountTag lang={lang} journey={journey} /></dd></div>
      </dl>
      {price && price.amountMinor === 0 && price.isExplicitlyFree ? <p className="muted">{c.freeOfferNote}</p> : null}
      {enabled && priced && !waived ? <p className="muted">{c.waiverNotApplied}</p> : null}
      <BetaStateNotice lang={lang} read={read} hideActive />
      {note && journey.state === 'ACTIVE' ? <p className="muted qx-hint">{note}</p> : null}
      <p className="muted qx-hint">{c.frozenNote}</p>
      {children}
    </section>
  );
}

/** Mission creation: one line stating the free-beta terms, plus the blocking state if any. */
export function BetaInlineBanner({ lang, read }: { lang: Locale; read: BetaJourneyRead }) {
  const c = betaCopy(lang);
  const journey = read.journey;
  return (
    <div className="qx-beta-inline" data-beta-state={journey?.state ?? 'UNAVAILABLE'}>
      {journey ? (
        <p className="qx-beta-headline">
          <span aria-hidden="true">◆ </span>{journey.freeBeta.enabled ? c.headline : c.headlineDisabled}
          {' · '}{c.dueToday}: <strong>{dueToday(lang, journey, null)}</strong>
          {journey.account.missionQuota !== null && journey.account.missionsRemaining !== null
            ? <>{' · '}{c.remaining}: <strong>{c.remainingValue(journey.account.missionsRemaining, journey.account.missionQuota)}</strong></>
            : null}
        </p>
      ) : null}
      <BetaStateNotice lang={lang} read={read} hideActive compact />
    </div>
  );
}

/** MyDash: the workspace's beta account, allowance and expiry, plus activation of a pending invitation. */
export function BetaAccountCard({ lang, read }: { lang: Locale; read: BetaJourneyRead }) {
  const c = betaCopy(lang);
  const journey = read.journey;
  const a = journey?.account;
  const used = a && a.missionQuota && a.missionsUsed !== null ? Math.min(100, Math.round((a.missionsUsed / a.missionQuota) * 100)) : 0;
  return (
    <section className="card qx-beta-account" id="beta-access" aria-labelledby="beta-access-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{c.eyebrow}</p>
          <h2 id="beta-access-title">{c.cardTitle}</h2>
        </div>
        {journey ? <BetaAccountTag lang={lang} journey={journey} /> : null}
      </div>
      {journey ? <p className="qx-beta-headline"><span aria-hidden="true">◆ </span>{journey.freeBeta.enabled ? c.headline : c.headlineDisabled}</p> : null}
      <BetaStateNotice lang={lang} read={read} />
      {journey && a ? (
        <>
          {a.missionQuota !== null && a.missionsRemaining !== null ? (
            <div className="qx-beta-meter">
              <p><span>{c.remaining}</span> <strong>{c.remainingValue(a.missionsRemaining, a.missionQuota)}</strong></p>
              <div className="progress" role="progressbar" aria-label={c.remaining} aria-valuemin={0} aria-valuemax={a.missionQuota} aria-valuenow={a.missionsUsed ?? 0} aria-valuetext={c.remainingValue(a.missionsRemaining, a.missionQuota)}>
                <span style={{ width: used + '%' }} />
              </div>
            </div>
          ) : null}
          <dl className="qx-beta-facts">
            <div className="qx-beta-due"><dt>{c.dueToday}</dt><dd><strong>{dueToday(lang, journey, null)}</strong></dd></div>
            {a.status === 'INVITED'
              ? <div><dt>{c.invitationExpires}</dt><dd>{betaDate(lang, a.invitationExpiresAt)}</dd></div>
              : a.expiresAt ? <div><dt>{c.expires}</dt><dd>{betaDate(lang, a.expiresAt)}</dd></div> : null}
            {a.concurrentLimit !== null ? <div><dt>{c.running}</dt><dd>{c.runningValue(a.activeMissions, a.concurrentLimit)}</dd></div> : null}
            {a.providerBudgetRemainingMinor !== null && a.currency ? <div><dt>{c.providerBudget}</dt><dd>{formatMoney(Math.max(0, a.providerBudgetRemainingMinor), a.currency, lang)}</dd></div> : null}
            <div><dt>{c.runtime}</dt><dd>{c.runtimeState[journey.runtime.state]}</dd></div>
          </dl>
          {a.status === 'INVITED' ? (a.canActivate ? <BetaActivateForm lang={lang} /> : <p className="muted">{c.activateAskAdmin}</p>) : null}
        </>
      ) : null}
      <p className="muted qx-hint">{c.frozenNote}</p>
    </section>
  );
}
