import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell, Card, Feedback, PageHeader } from '../../../../components/ui';
import { api, ApiError, session } from '../../../../lib/api';
import { copy, locale } from '../../../../lib/copy';
import { serviceCopy } from '../../../../lib/service-copy';
import { formatMoney } from '../../../../lib/money';
import { ServiceRequestForm } from '../../../../components/service-request-form';
import { readBetaJourney, type BetaJourneyRead } from '../../../../lib/beta';
import { BetaOfferSummary } from '../../../../components/beta-offer';
import { serviceDetailSchema, type ServiceDetail } from '@qeynox/contracts';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ lang: string; offerId: string }> }) {
  const { lang: rawLang, offerId } = await params;
  const lang = locale(rawLang);
  const t = copy[lang];
  const s = serviceCopy(lang);
  const current = await session();
  const configured = Boolean(process.env.QEYNOX_API_URL);
  let detail: ServiceDetail | null = null;
  let failure = '';
  let missing = false;
  let beta: BetaJourneyRead | null = null;
  if (current && configured) {
    // MISSION A21.04 — the beta journey is read in parallel; its failure never hides the service.
    const journey = readBetaJourney();
    try { detail = serviceDetailSchema.parse(await api('/v1/services/' + encodeURIComponent(offerId))); }
    catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') missing = true;
      else failure = error instanceof ApiError ? error.code : 'UNAVAILABLE';
    }
    beta = await journey;
  }
  if (missing) notFound();
  const failureText = (code: string) => code === 'DENIED' ? t.denied : code === 'NOT_CONFIGURED' ? t.notConfigured : code === 'SESSION_REQUIRED' ? t.signInRequired : t.error;
  const readinessLabel = (state: string) => s.readiness[state] ?? state;
  const blockerLabel = (code: string) => code.startsWith('PROVIDER:') ? code.slice('PROVIDER:'.length) + ' — ' + s.blockers.PROVIDER_NOT_CONFIGURED : (s.blockers[code] ?? code);
  const free = detail && detail.isExplicitlyFree && detail.amountMinor === 0;
  const priceInvalid = detail && detail.amountMinor === 0 && !detail.isExplicitlyFree;
  const domainLabel = detail?.packDomain ? (s.packDomains[detail.packDomain] ?? detail.packDomain) : null;
  const usesBrave = detail?.deployment?.requiredProvider === 'brave-search';
  const blockedConnectors = detail?.deployment?.unavailableExternalConnectors ?? [];

  return (
    <AppShell lang={lang} active="services">
      <PageHeader
        eyebrow={domainLabel ? `${s.title} · ${domainLabel}` : s.title}
        title={detail?.displayName ?? detail?.label ?? s.viewDetails}
        description={detail ? s.offeredBy + ' · v' + detail.version + ' · ' + detail.deliverableSchemaVersion + ' ' + s.deliverable : s.intro}
        aside={<Link className="button secondary" href={'/' + lang + '/services'}>← {s.title}</Link>}
      />

      {!configured ? <Feedback title={t.notConfigured} /> : !current ? (
        <Feedback title={t.signInRequired}><Link href={'/' + lang + '/account'}>{t.signin} →</Link></Feedback>
      ) : failure ? (
        <Card><Feedback error title={failureText(failure)}>{failure}</Feedback></Card>
      ) : null}

      {detail ? (
        <>
          <Card>
            <div className="qx-service-head">
              {domainLabel ? <span className="badge">{domainLabel}</span> : null}
              {free
                ? <span className="badge success">{s.priceFree}</span>
                : priceInvalid
                  ? <span className="badge danger">{s.priceInvalid}</span>
                  : <span className="qx-price" data-list-price="true"><span className="qx-kicker">{s.listPrice}</span> <strong>{formatMoney(detail.amountMinor, detail.currency, lang)}</strong></span>}
              <span className="badge" data-state={detail.availability.operationalState}>{readinessLabel(detail.availability.operationalState)}</span>
              {detail.taxPolicy === 'CONFIG_REQUIRED'
                ? <span className="badge danger">{s.taxRequired}</span>
                : <span className="badge success">{s.taxConfigured}</span>}
            </div>
            <p className="muted qx-service-terms">{s.terms}: {detail.termsVersion || '—'} · {s.regions}: {detail.regions.join(', ') || '—'} · {s.locales}: {detail.locales.join(', ') || '—'}</p>

            {detail.specialization ? (
              <p><strong>{s.specializationTitle}:</strong> {detail.specialization}</p>
            ) : null}

            <div className="qx-service-columns">
              <section>
                <h2>{s.scope}</h2>
                <ul className="qx-chip-list">{detail.scope.map((item, index) => <li key={index}>{item}</li>)}</ul>
                {detail.contractMeta?.deliverableSections.length ? (
                  <>
                    <h2>{s.deliverableSectionsTitle}</h2>
                    <ul className="qx-chip-list">
                      {detail.contractMeta.deliverableSections.map((section, index) => <li key={index}>{section}</li>)}
                    </ul>
                  </>
                ) : null}
                {detail.exclusions.length ? (
                  <>
                    <h2>{s.exclusions}</h2>
                    <ul className="qx-chip-list qx-chip-exclusive">{detail.exclusions.map((item, index) => <li key={index}>{item}</li>)}</ul>
                  </>
                ) : null}
              </section>

              <section>
                <h2>{s.availabilityTitle}</h2>
                <p>{detail.availability.isExecutable ? s.availabilityReady : s.availabilityNotReady}</p>
                {!detail.availability.isExecutable && detail.availability.blockers.length ? (
                  <ul className="qx-service-blockers">{detail.availability.blockers.map(code => <li key={code}>{blockerLabel(code)}</li>)}</ul>
                ) : null}
                <h2>{s.capabilitiesUsed}</h2>
                <ul className="qx-service-capabilities">
                  {detail.capabilities.map(capability => (
                    <li key={capability.id}>
                      <strong>{capability.name}</strong>
                      <span className="muted">{capability.purpose}</span>
                      <span className="muted">{s.maxSteps}: {capability.maximumSteps} · {s.maxTools}: {capability.maximumToolCalls} · {readinessLabel(capability.operationalState)}</span>
                    </li>
                  ))}
                </ul>
                <h2>{s.deploymentTitle}</h2>
                {detail.deployment ? (
                  <ul className="qx-service-blockers">
                    {usesBrave ? (
                      <>
                        <li>{detail.deployment.braveSearchEnabled ? s.deploymentBraveOn : s.deploymentBraveOff}</li>
                        <li>{detail.deployment.braveSearchKeyConfigured ? s.deploymentBraveKeyOn : s.deploymentBraveKeyOff}</li>
                        <li>{s.deploymentConsentWebSearch}</li>
                      </>
                    ) : (
                      <li>{detail.deployment.worldBankEnabled ? s.deploymentProviderOn : s.deploymentProviderOff}</li>
                    )}
                    <li>{detail.deployment.egressAttested ? s.deploymentEgressAttested : s.deploymentEgressUnattested}</li>
                  </ul>
                ) : <Feedback title={lang === 'fr' ? 'Aucune sonde de déploiement pour ce contrat.' : 'No deployment probe for this contract.'} />}

                {blockedConnectors.length > 0 ? (
                  <>
                    <h2>{s.blockedConnectorsTitle}</h2>
                    <p className="muted">{s.blockedConnectorsIntro}</p>
                    <ul className="qx-service-blockers">
                      {blockedConnectors.map(conn => (
                        <li key={conn.connectorId}>
                          <strong>{conn.connectorId} [{conn.state}]</strong> — {conn.purpose} ({conn.blocker})
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </section>
            </div>
          </Card>

          <Card>
            <h2>{s.requestTitle}</h2>
            <p className="muted">{s.requestIntro}</p>
            {beta && !priceInvalid ? <BetaOfferSummary lang={lang} read={beta} context="service" price={{ amountMinor: detail.amountMinor, currency: detail.currency, isExplicitlyFree: detail.isExplicitlyFree }} /> : null}
            {detail.requestable ? (
              <>
                {!detail.availability.isExecutable ? (
                  <Feedback title={s.availabilityNotReady}>{detail.availability.blockers.map(blockerLabel).join(' · ')}</Feedback>
                ) : null}
                <ServiceRequestForm
                  lang={lang}
                  offerId={detail.offerId}
                  contractKey={detail.contractKey}
                  contractMeta={detail.contractMeta}
                  disabled={!current}
                />
              </>
            ) : (
              <>
                <Feedback error title={detail.unavailableReason === 'CAPABILITY_NOT_CONFIGURED' ? s.capabilityMissing : detail.unavailableReason === 'SERVICE_NOT_CONFIGURED' ? s.notConfigured : s.availabilityBlocked} />
                <ServiceRequestForm
                  lang={lang}
                  offerId={detail.offerId}
                  contractKey={detail.contractKey}
                  contractMeta={detail.contractMeta}
                  disabled
                />
              </>
            )}
            <p className="muted">{s.manual} <Link href={'/' + lang + '/mydash'}>→</Link></p>
          </Card>
        </>
      ) : null}
    </AppShell>
  );
}
