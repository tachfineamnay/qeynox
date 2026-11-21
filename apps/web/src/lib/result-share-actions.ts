'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  createdResultShareSchema,
  idSchema,
  resultShareSummarySchema,
} from '@qeynox/contracts';
import { api, ApiError } from './api';
import { safeUrl } from './mission';

export interface ArtifactActionState {
  readonly code: string;
  readonly artifactId?: string;
  readonly url?: string;
  readonly sha256?: string;
  readonly format?: 'json' | 'html' | 'pdf';
  readonly recoveredCount?: number;
}

export async function artifactAction(
  _previous: ArtifactActionState,
  form: FormData,
): Promise<ArtifactActionState> {
  try {
    const kind = z.enum(['export', 'grant', 'reconcile']).parse(form.get('kind'));
    const lang = form.get('lang') === 'fr' ? 'fr' : 'en';
    const operationId = idSchema.parse(form.get('operationId'));
    const documentId = idSchema.parse(form.get('documentId'));
    const base = `/v1/operations/${encodeURIComponent(operationId)}/documents`;

    if (kind === 'reconcile') {
      const reconciled = z
        .object({
          recovered: z.array(z.string()),
          pending: z.array(z.string()),
          conflicts: z.array(z.string()),
        })
        .parse(await api(`${base}/reconcile`, 'POST'));
      revalidatePath(`/${lang}/results/${documentId}`);
      revalidatePath(`/${lang}/results`);
      return { code: 'OK', recoveredCount: reconciled.recovered.length };
    }

    let artifactId: string;
    let sha256: string | undefined;
    let format: 'json' | 'html' | 'pdf' | undefined;

    if (kind === 'export') {
      format = z.enum(['json', 'html', 'pdf']).parse(form.get('format'));
      const saved = z
        .object({
          artifactId: idSchema,
          sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
        })
        .parse(await api(`${base}/${encodeURIComponent(documentId)}/export/${format}`, 'POST'));
      artifactId = saved.artifactId;
      sha256 = saved.sha256;
      revalidatePath(`/${lang}/results/${documentId}`);
      revalidatePath(`/${lang}/results`);
    } else {
      artifactId = idSchema.parse(form.get('artifactId'));
    }

    const grant = z
      .object({ url: z.string() })
      .parse(
        await api(
          `${base}/${encodeURIComponent(documentId)}/artifacts/${encodeURIComponent(artifactId)}`,
        ),
      );
    const url = safeUrl(grant.url);
    if (!url) return { code: 'INVALID_RESPONSE', artifactId, sha256, format };
    return { code: 'OK', artifactId, url, sha256, format };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_INPUT' };
  }
}

export interface ShareActionState {
  readonly code: string;
  readonly token?: string;
  readonly sharePath?: string;
  readonly expiresAt?: string;
  readonly label?: string | null;
  readonly revokedId?: string;
}

export async function createShareAction(
  _previous: ShareActionState,
  form: FormData,
): Promise<ShareActionState> {
  try {
    const lang = form.get('lang') === 'fr' ? 'fr' : 'en';
    const documentId = idSchema.parse(form.get('documentId'));
    const rawLabel = String(form.get('label') ?? '').trim();
    const expiresInHours = z.coerce.number().int().min(1).max(720).parse(form.get('expiresInHours'));

    const created = createdResultShareSchema.parse(
      await api(`/v1/results/${encodeURIComponent(documentId)}/shares`, 'POST', {
        ...(rawLabel ? { label: rawLabel } : {}),
        expiresInHours,
      }),
    );

    revalidatePath(`/${lang}/results/${documentId}`);
    revalidatePath(`/${lang}/results`);

    return {
      code: 'OK',
      token: created.token,
      sharePath: `/${lang}${created.sharePath}`,
      expiresAt: created.share.expiresAt,
      label: created.share.label,
    };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_INPUT' };
  }
}

export async function revokeShareAction(
  _previous: ShareActionState,
  form: FormData,
): Promise<ShareActionState> {
  try {
    const lang = form.get('lang') === 'fr' ? 'fr' : 'en';
    const documentId = idSchema.parse(form.get('documentId'));
    const shareId = idSchema.parse(form.get('shareId'));

    const revoked = resultShareSummarySchema.parse(
      await api(
        `/v1/results/${encodeURIComponent(documentId)}/shares/${encodeURIComponent(shareId)}/revoke`,
        'POST',
      ),
    );

    revalidatePath(`/${lang}/results/${documentId}`);
    revalidatePath(`/${lang}/results`);

    return { code: 'OK', revokedId: revoked.id };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_INPUT' };
  }
}
