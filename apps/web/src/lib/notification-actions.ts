'use server';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { api, ApiError } from './api';
import { notificationPreferenceSchema } from './notifications';

export interface NotificationState { code: string }

const fail = (error: unknown): NotificationState => ({ code: error instanceof ApiError ? error.code : 'UNAVAILABLE' });

export async function markNotificationReadAction(id: string): Promise<NotificationState> {
  try {
    await api('/v1/notifications/' + idSchema.parse(id) + '/read', 'POST', {});
    return { code: 'OK' };
  } catch (error) { return fail(error); }
}

export async function markAllNotificationsReadAction(): Promise<NotificationState & { updated?: number }> {
  try {
    const result = z.object({ updated: z.number().int().nonnegative() }).parse(await api('/v1/notifications/read-all', 'POST', {}));
    return { code: 'OK', updated: result.updated };
  } catch (error) { return fail(error); }
}

export async function setNotificationPreferenceAction(category: string, emailEnabled: boolean): Promise<NotificationState> {
  try {
    const parsed = notificationPreferenceSchema.parse({ category, emailEnabled });
    await api('/v1/notifications/preferences', 'POST', parsed);
    return { code: 'OK' };
  } catch (error) { return fail(error); }
}
