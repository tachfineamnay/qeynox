import Link from 'next/link';
import { AppShell, Card, EmptyState, Feedback, PageHeader } from '../../../components/ui';
import { api, session } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { serviceCopy } from '../../../lib/service-copy';
import { formatMoney } from '../../../lib/money';
import { serviceListSchema, type ServiceSummary } from '@qeynox/contracts';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const s = serviceCopy(lang);
  const current = await session();
  const configured = Boolean(process.env.QEYNOX_API_URL);
  let services: ServiceSummary[] | null = null;
  let failure = '';
  if (current && configured) {
    try { services = serviceListSchema.parse(await api('/v1/services')); }
    catch (error) { failure = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'UNAVAILABLE'; }
  }
  const failureText = (code: string) => code === 'DENIED' ? t.denied : code === 'NOT_CONFIGURED' ? t.notConfigured : code === 'SESSION_REQUIRED' ? t.signInRequired : t.error;
  const readinessLabel = (state: string) => s.readiness[state] ?? state;
  const blockerLabel = (code: string) => code.startsWith('PROVIDER:') ? code.slice('PROVIDER:'.length) + ' — ' + s.blockers.PROVIDER_NOT_CONFIGURED : (s.blockers[code] ?? code);

  return (
    <AppShell lang={lang} active="services">
      <PageHeader eyebrow={t.eyebrow} title={s.title} description={s.intro} aside={<Link className="button secondary" href={'/' + lang + '/services'}>{s.refresh}</Link>} />

      {!configured ? <Feedback title={t.notConfigured} /> : !current ? (
        <Feedback title={t.signInRequired}><Link href={'/' + lang + '/account'}>{t.signin} →</Link></Feedback>
      ) : failure ? (
        <Card><Feedback error title={failureText(failure)}>{failure}</Feedback></Card>
      ) : null}

      {services ? (
        services.length === 0 ? (
          <Card><EmptyState title={s.empty} mark="◇">{s.emptyCopy}</EmptyState></Card>
        ) : (
          <>
            <ul className="qx-service-grid">
              {services.map(service => {
                const free = service.isExplicitlyFree && service.amountMinor === 0;
                const priceInvalid = service.amountMinor === 0 && !service.isExplicitlyFree;
                return (
                  <li key={service.offerId} className="qx-service-card" data-ready={service.availability.isExecutable ? 'true' : 'false'}>
                    <div className="qx-service-card-head">
                      <h2><Link href={'/' + lang + '/services/' + encodeURIComponent(service.offerId)}>{service.label}</Link></h2>
                      {free
                        ? <span className="badge success">{s.priceFree}</span>
                        : priceInvalid
                          ? <span className="badge danger">{s.priceInvalid}</span>
                          : <span className="qx-price"><strong>{formatMoney(service.amountMinor, service.currency, lang)}</strong></span>}
                    </div>
                    <p className="muted">{s.offeredBy} · v{service.version} · {service.termsVersion}</p>
                    <div className="qx-service-availability">
                      <span className="badge" data-state={service.availability.operationalState}>{readinessLabel(service.availability.operationalState)}</span>
                      {!service.availability.isExecutable ? (
                        <ul className="qx-service-blockers">
                          <li><strong>{s.availabilityBlocked}</strong></li>
                          {service.availability.blockers.map(code => <li key={code}>{blockerLabel(code)}</li>)}
                        </ul>
                      ) : null}
                    </div>
                    {service.scope.length ? <ul className="qx-chip-list">{service.scope.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
                    <p className="muted">{s.regions}: {service.regions.join(', ') || '—'} · {s.locales}: {service.locales.join(', ') || '—'}</p>
                    <Link className="button secondary" href={'/' + lang + '/services/' + encodeURIComponent(service.offerId)}>{s.viewDetails} →</Link>
                  </li>
                );
              })}
            </ul>
            <p className="muted qx-service-foot">{s.operatorOnly}</p>
          </>
        )
      ) : null}
    </AppShell>
  );
}
