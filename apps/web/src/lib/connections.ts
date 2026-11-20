import 'server-only';
import { z } from 'zod';
import { connectionViewSchema, connectionAuditListSchema } from '@qeynox/contracts';

/** Wire validation for the connections API (single source of truth: @qeynox/contracts). */
export const ConnectionViewSchema = z.array(connectionViewSchema);
export const ConnectionAuditSchema = connectionAuditListSchema;
export type ConnectionView = z.infer<typeof connectionViewSchema>;
export type ConnectionAudit = z.infer<typeof connectionAuditListSchema>[number];
