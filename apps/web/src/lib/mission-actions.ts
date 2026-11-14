'use server';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { api, ApiError } from './api';
import { detailSchema, safeUrl } from './mission';
export type ChangeState = { code: string; consentId?: string; artifactId?: string; url?: string; sha256?: string };
export async function change(previous: ChangeState, form: FormData): Promise<ChangeState> {
  try {
    const kind = String(form.get('kind'));
    const id = () => idSchema.parse(form.get('id'));
    if (kind === 'interrupt') {
      if (form.get('confirm') !== 'on') return { code: 'INVALID_INPUT' };
      const operation = detailSchema.parse(await api(`/v1/operations/${id()}`));
      const expectedVersion = z.coerce.number().int().positive().parse(form.get('version'));
      if (operation.version !== expectedVersion) return { code: 'CONFLICT' };
      await api(`/v1/operations/${id()}/interrupt`, 'POST', { expectedVersion });
    } else if (kind === 'grant') {
      if (form.get('confirm') !== 'on') return { code: 'INVALID_INPUT' };
      const purpose = z.string().trim().min(3).max(200).parse(form.get('purpose'));
      const consent = z.object({ id: idSchema }).parse(await api('/v1/soul/consents', 'POST', { purpose, scopes: ['context:read','context:write'] }));
      return { code: 'OK', consentId: consent.id };
    } else if (kind === 'save') {
      const key = z.string().trim().min(1).max(80).parse(form.get('key'));
      const value = z.string().max(5000).parse(form.get('value'));
      await api('/v1/soul/context/facts', 'POST', { key, value, consentId: idSchema.parse(form.get('consentId')) });
    } else if (kind === 'delete' || kind === 'revoke') {
      if (form.get('confirm') !== 'on') return { code: 'INVALID_INPUT' };
      await api(kind === 'delete' ? `/v1/soul/context/facts/${id()}` : `/v1/soul/consents/${id()}/revoke`, kind === 'delete' ? 'DELETE' : 'POST');
    } else if (kind === 'redo') {
      if (form.get('confirm') !== 'on') return { code: 'INVALID_INPUT' };
      const expectedVersion = z.coerce.number().int().positive().parse(form.get('version'));
      const idempotencyKey = z.string().min(8).max(200).parse(form.get('idempotencyKey'));
      await api(`/v1/operations/${idSchema.parse(form.get('operationId'))}/attempts/${idSchema.parse(form.get('attemptId'))}/redo`, 'POST', { expectedVersion, idempotencyKey });
    } else if (kind === 'export' || kind === 'renew') {
      const operationId = idSchema.parse(form.get('operationId'));
      const documentId = idSchema.parse(form.get('documentId'));
      const base = `/v1/operations/${operationId}/documents/${documentId}`;
      let artifactId: string;
      let sha256: string | undefined;
      if (kind === 'renew') {
        artifactId = idSchema.parse(form.get('artifactId'));
      } else {
        const saved = z.object({ artifactId: idSchema, sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }).parse(await api(`${base}/export/${z.enum(['json','html']).parse(form.get('format'))}`, 'POST'));
        artifactId = saved.artifactId;
        sha256 = saved.sha256;
      }
      try {
        const grant = z.object({ url: z.string() }).parse(await api(`${base}/artifacts/${artifactId}`));
        const url = safeUrl(grant.url);
        if (!url) return { code: 'INVALID_RESPONSE', artifactId };
        return { code: 'OK', artifactId, url, sha256 };
      } catch (error) { return { code: error instanceof ApiError ? error.code : 'UNAVAILABLE', artifactId, sha256 }; }
    } else return { code: 'INVALID_INPUT' };
    return { code: 'OK' };
  } catch (error) { return { code: error instanceof ApiError ? error.code : 'INVALID_INPUT' }; }
}
