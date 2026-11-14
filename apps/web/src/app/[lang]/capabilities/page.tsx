import Link from 'next/link';
import { AppShell, Card, EmptyState, Feedback, PageHeader, StatusBadge } from '../../../components/ui';
import { api, ApiError, session } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { capabilityCatalogueSchema, type CapabilityCatalogue } from '../../../lib/plan';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const c = t.capabilityPage;
  const current = await session();
  const configured = Boolean(process.env.QEYNOX_API_URL);
  let catalogue: CapabilityCatalogue | null = null;
  let failure = '';
  if (current && configured) {
    try { catalogue = capabilityCatalogueSchema.parse(await api('/v1/capabilities')); }
    catch (error) { failure = error instanceof ApiError ? error.code : 'UNAVAILABLE'; }
  }
  return (
    <AppShell lang={lang} active="capabilities">
      <PageHeader
        eyebrow={t.eyebrow}
        title={c.title}
        description={c.intro}
        aside={<Link className="button secondary" href={'/' + lang + '/capabilities'}>{c.refresh}</Link>}
      />

      {!configured ? <Feedback title={t.notConfigured} /> : !current ? (
        <Feedback title={t.signInRequired}><Link href={'/' + lang + '/account'}>{t.signin} →</Link></Feedback>
      ) : failure ? (
        <Card><Feedback error title={failure === 'DENIED' ? t.denied : t.error}>{failure}</Feedback></Card>
      ) : null}

      {catalogue ? (
        <>
          <Card>
            <div className="qx-capability-summary">
              <p><strong>{catalogue.active}</strong> / {catalogue.total} <span className="muted">{c.slotsLabel} · {c.activeCount}</span></p>
              <p><strong>{catalogue.available}</strong> <span className="muted">{c.availableCount}</span></p>
            </div>
            <p className="muted">{c.operatorOnly}</p>
          </Card>

          {catalogue.active === 0 ? <Card><EmptyState title={c.empty} mark="◇" /></Card> : null}

          <ul className="qx-capability-grid">
            {catalogue.slots.map(slot => (
              <li key={slot.slot} className="qx-capability-card" data-available={slot.available ? 'true' : 'false'}>
                <div className="qx-capability-head">
                  <span className="qx-slot">{c.slotLabel} {slot.slot}</span>
                  <StatusBadge status={slot.status} lang={lang} />
                  {slot.available ? <span className="badge success">{c.availableCount}</span> : null}
                </div>
                {slot.capability ? (
                  <>
                    <h2>{slot.capability.name}</h2>
                    <p className="muted">{slot.capability.purpose}</p>
                    <dl className="qx-capability-limits">
                      <div><dt>{c.maxSteps}</dt><dd>{slot.capability.maximumSteps}</dd></div>
                      <div><dt>{c.maxTools}</dt><dd>{slot.capability.maximumToolCalls}</dd></div>
                    </dl>
                    {slot.capability.scope.length ? (
                      <>
                        <h3>{c.scope}</h3>
                        <ul className="qx-chip-list">{slot.capability.scope.map((item, position) => <li key={position}>{item}</li>)}</ul>
                      </>
                    ) : null}
                    <p className="muted">{slot.capability.externalActions ? c.external : c.noExternal}</p>
                    {!slot.capability.profileReady ? <Feedback error title={c.missingProfile} /> : null}
                    {slot.capability.missingProviders.length ? (
                      <Feedback error title={c.missingProvider}>{slot.capability.missingProviders.join(', ')}</Feedback>
                    ) : null}
                    {!slot.available && slot.capability.profileReady && slot.capability.providerReady ? (
                      <Feedback title={c.configuredBlocked} />
                    ) : null}
                  </>
                ) : (
                  <p className="muted">{c.unconfigured}</p>
                )}
              </li>
            ))}
          </ul>

          <p className="qx-capability-foot"><Link href={'/' + lang + '/missions'}>{c.openMissions} →</Link></p>
        </>
      ) : null}
    </AppShell>
  );
}
