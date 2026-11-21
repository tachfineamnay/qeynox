import { z } from 'zod';

/** MISSION A19 — wire contracts for the notification inbox and preferences. */
export const notificationCategorySchema = z.enum(['APPROVALS', 'EXECUTION_FAILURES', 'RESULTS']);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

export const inboxItemSchema = z.object({
  id: z.string(),
  kind: notificationCategorySchema,
  title: z.string(),
  body: z.string(),
  operationId: z.string().nullable(),
  linkPath: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const inboxPageSchema = z.object({
  items: z.array(inboxItemSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export type InboxPage = z.infer<typeof inboxPageSchema>;

export const notificationPreferenceSchema = z.object({ category: notificationCategorySchema, emailEnabled: z.boolean() });
export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;
export const notificationPreferencesSchema = z.array(notificationPreferenceSchema);
