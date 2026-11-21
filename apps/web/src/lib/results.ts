import 'server-only';
import { z } from 'zod';
import {
  atlasLibraryDetailSchema,
  atlasLibraryPageSchema,
  resultShareSummarySchema,
  sharedAtlasResultViewSchema,
  type AtlasLibraryDetail,
  type AtlasLibraryPage,
  type ResultShareSummary,
  type SharedAtlasResultView,
} from '@qeynox/contracts';
import { api, ApiError } from './api';

export type ReadOutcome<T> = { data: T; code?: never } | { data?: never; code: string };

export async function readResultsLibrary(
  params: Record<string, string | undefined>,
): Promise<ReadOutcome<AtlasLibraryPage>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      search.set(key, value.trim());
    }
  }
  const suffix = search.toString();
  const path = suffix ? `/v1/results?${suffix}` : '/v1/results';
  try {
    const raw = await api(path);
    return { data: atlasLibraryPageSchema.parse(raw) };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_RESPONSE' };
  }
}

export async function readResultDetail(
  documentId: string,
  compareWith?: string,
): Promise<ReadOutcome<AtlasLibraryDetail>> {
  const suffix =
    compareWith && compareWith.trim().length > 0
      ? `?compareWith=${encodeURIComponent(compareWith.trim())}`
      : '';
  const path = `/v1/results/${encodeURIComponent(documentId)}${suffix}`;
  try {
    const raw = await api(path);
    return { data: atlasLibraryDetailSchema.parse(raw) };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_RESPONSE' };
  }
}

export async function readResultShares(
  documentId: string,
): Promise<ReadOutcome<readonly ResultShareSummary[]>> {
  const path = `/v1/results/${encodeURIComponent(documentId)}/shares`;
  try {
    const raw = await api(path);
    return { data: z.array(resultShareSummarySchema).parse(raw) };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_RESPONSE' };
  }
}

export async function readSharedResult(
  token: string,
): Promise<ReadOutcome<SharedAtlasResultView>> {
  const path = `/v1/public/shared-results/${encodeURIComponent(token)}`;
  try {
    const raw = await api(path, 'GET', undefined, false);
    return { data: sharedAtlasResultViewSchema.parse(raw) };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_RESPONSE' };
  }
}
