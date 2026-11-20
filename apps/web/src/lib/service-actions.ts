'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { serviceRequestEnvelopeSchema, serviceRequestResultSchema } from '@qeynox/contracts';
import { api, ApiError } from './api';
import { locale } from './copy';

export type ServiceRequestState = { code: string };

const optionalCode = z.string().trim().max(64).optional();
const formSchema = z.object({
  lang: z.enum(['en', 'fr']),
  offerId: z.string().min(4).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  service: z.string().min(1).max(120),
  objective: z.string().trim().min(20).max(5000),
  country: z.string().trim().min(2).max(3),
  indicator: z.string().trim().min(3).max(64),
  mostRecent: z.coerce.number().int().min(1).max(5),
  minObservationYear: z.union([z.literal(''), z.coerce.number().int().min(1960).max(new Date().getUTCFullYear())]).optional(),
  compareIndicators: z.array(optionalCode).max(2),
  includeInterpretation: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

/**
 * Request a published service: validates the typed form, posts the envelope to the API, then lands
 * on the mission workspace (which holds the plan, the quote and the acceptance). Nothing is quoted,
 * accepted, charged or executed here.
 */
export async function requestService(previous: ServiceRequestState, form: FormData): Promise<ServiceRequestState> {
  void previous;
  const lang = locale(String(form.get('lang')));
  const offerId = String(form.get('offerId') ?? '');
  const compareIndicators = [form.get('compare1'), form.get('compare2')]
    .map(value => String(value ?? '').trim())
    .filter(value => value.length > 0)
    .slice(0, 2);
  const minYearRaw = String(form.get('minObservationYear') ?? '').trim();
  const noteRaw = String(form.get('note') ?? '').trim();
  const parsed = formSchema.safeParse({
    lang,
    offerId,
    service: String(form.get('service') ?? ''),
    objective: String(form.get('objective') ?? '').trim(),
    country: String(form.get('country') ?? '').trim(),
    indicator: String(form.get('indicator') ?? '').trim(),
    mostRecent: form.get('mostRecent') ?? 3,
    minObservationYear: minYearRaw === '' ? '' : minYearRaw,
    compareIndicators,
    includeInterpretation: String(form.get('includeInterpretation') ?? '') === 'on',
    ...(noteRaw !== '' ? { note: noteRaw } : {}),
  });
  if (!parsed.success) return { code: 'INVALID_INPUT' };
  const input = {
    objective: parsed.data.objective,
    country: parsed.data.country,
    indicator: parsed.data.indicator,
    constraints: {
      mostRecent: parsed.data.mostRecent,
      ...(parsed.data.minObservationYear !== undefined && parsed.data.minObservationYear !== '' ? { minObservationYear: Number(parsed.data.minObservationYear) } : {}),
      ...(compareIndicators.length ? { compareIndicators } : {}),
      includeInterpretation: parsed.data.includeInterpretation === true,
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
    },
  };
  const envelope = serviceRequestEnvelopeSchema.safeParse({ service: parsed.data.service, input });
  if (!envelope.success) return { code: 'INVALID_INPUT' };
  let operationId: string;
  try {
    const value = await api('/v1/services/' + encodeURIComponent(offerId) + '/requests', 'POST', envelope.data);
    operationId = serviceRequestResultSchema.parse(value).operationId;
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME' };
  }
  redirect('/' + lang + '/missions/' + encodeURIComponent(operationId));
}
