import Link from 'next/link';
import { requirePlatformMe, tryApi } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { can, READ_CATALOGUE } from '../../../lib/permissions';
import { ApiErrorNotice, Badge, Card, Notice, PageHeader, PermissionDenied, Shell } from '../../../components/shell';
import type { PlatformCatalogueView } from '../../../lib/types';

export default async function SettingsPage({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, READ_CATALOGUE);
  const result = allowed ? await tryApi<PlatformCatalogueView>('/v1/platform/capabilities') : null;
  const catalogue = result && result.ok ? result.value : null;
  return (
    <Shell lang={lang} path="/settings" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <PageHeader
        title={t.settingsTitle}
        intro={t.settingsIntro}
        actions={me.roles.map(role => <Badge key={role} tone="neutral">{role}</Badge>)}
      />
      {!allowed ? <PermissionDenied lang={lang} /> : null}
      {result && !result.ok ? <ApiErrorNotice lang={lang} code={result.code} /> : null}

      {catalogue ? (
        <>
          <Card>
            <h2>{t.sessionBoundaryTitle}</h2>
            <p>{t.sessionBoundary}</p>
            <dl className="kv">
              <dt>{t.sessionRoles}</dt><dd>{me.roles.join(' · ')}</dd>
              <dt>{t.permissions}</dt><dd>{me.permissions.join(' · ')}</dd>
            </dl>
          </Card>

          <Card>
            <h2>{t.runtimeTitle}</h2>
            <p className="muted">{t.runtimeIntro}</p>
            <dl className="kv">
              <dt>{t.engineLabel}</dt>
              <dd>
                <Badge tone={catalogue.runtime.engine.configured ? 'success' : 'warning'}>{catalogue.runtime.engine.configured ? t.configured : t.runtimeMissing}</Badge>
                {catalogue.runtime.engine.configured ? null : (
                  <ul className="plain-list">{catalogue.runtime.engine.missing.map(item => <li key={item}><code>{item}</code></li>)}</ul>
                )}
              </dd>
              <dt>{t.orchestratorLabel}</dt>
              <dd>
                <Badge tone={catalogue.runtime.orchestrator.configured ? 'success' : 'warning'}>{catalogue.runtime.orchestrator.configured ? t.configured : t.runtimeMissing}</Badge>
                {catalogue.runtime.orchestrator.configured ? null : (
                  <ul className="plain-list">{catalogue.runtime.orchestrator.missing.map(item => <li key={item}><code>{item}</code></li>)}</ul>
                )}
              </dd>
            </dl>
          </Card>

          <Card>
            <h2>{t.operatorTitle}</h2>
            <p>{t.operatorIntro}</p>
            <dl className="kv">
              <dt>{t.operatorScope}</dt><dd>{t.operatorScopeValue}</dd>
              <dt>{t.operatorEndpoint}</dt><dd><code>{catalogue.operator.configurationEndpoint}</code></dd>
              <dt>{t.operatorAllowlist}</dt>
              <dd><Badge tone={catalogue.operator.allowlistConfigured ? 'success' : 'warning'}>{catalogue.operator.allowlistConfigured ? t.allowlistConfigured : t.allowlistMissing}</Badge></dd>
            </dl>
          </Card>

          <Card>
            <h2>{t.capabilitySlots}</h2>
            <p className="muted">{catalogue.active} / {catalogue.total} · {t.capabilityAvailable}: {catalogue.available}</p>
            <p className="muted">{t.capabilityOperatorOnly}</p>
            {catalogue.active === 0 ? <p className="empty">{t.capabilityEmpty}</p> : null}
            <ul className="capability-list">
              {catalogue.slots.map(slot => (
                <li key={slot.slot}>
                  <div className="assignment-head">
                    <strong>#{slot.slot}</strong>
                    <Badge tone={slot.status === 'ACTIVE' ? 'success' : 'neutral'}>{slot.status === 'ACTIVE' ? t.active : t.capabilityUnconfigured}</Badge>
                    {slot.available ? <Badge tone="success">{t.capabilityAvailable}</Badge> : null}
                  </div>
                  {slot.capability ? (
                    <>
                      <h3>{slot.capability.name}</h3>
                      <p className="muted">{slot.capability.purpose}</p>
                      <dl className="kv">
                        <dt>{t.capabilityMaxSteps}</dt><dd>{slot.capability.maximumSteps}</dd>
                        <dt>{t.capabilityMaxTools}</dt><dd>{slot.capability.maximumToolCalls}</dd>
                        <dt>{t.capabilityExternal}</dt><dd>{slot.capability.externalActions ? t.yes : t.no}</dd>
                      </dl>
                      {!slot.capability.profileReady ? <Notice tone="warning" title={t.capabilityMissingProfile} /> : null}
                      {slot.capability.missingProviders.length ? (
                        <Notice tone="warning" title={t.capabilityMissingProvider}>{slot.capability.missingProviders.join(', ')}</Notice>
                      ) : null}
                      {!slot.available && slot.capability.profileReady && slot.capability.providerReady ? (
                        <Notice tone="warning" title={t.capabilityIncomplete} />
                      ) : null}
                    </>
                  ) : <p className="muted">{t.capabilityUnconfigured}</p>}
                </li>
              ))}
            </ul>
            <p className="pager"><Link href={'/' + lang + '/settings'}>{t.capabilityRefresh}</Link></p>
          </Card>
        </>
      ) : null}
    </Shell>
  );
}
