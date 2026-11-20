'use server';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { api, ApiError } from './api';

/** Mint a short-lived signed download URL for one document (never cached client-side). */
export async function downloadGrantAction(documentId: string): Promise<{ url: string }> {
  const grant = z.object({ url: z.string().url(), expiresInSeconds: z.number().int() }).parse(
    await api('/v1/documents/' + idSchema.parse(documentId) + '/download'),
  );
  return { url: grant.url };
}
