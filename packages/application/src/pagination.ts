import { DomainError } from '@qeynox/domain';

export interface PageCursor { readonly at: Date; readonly id: string }

/** Opaque page cursor: base64url of {at,id}; tampering only shifts the page window. */
export function encodePageCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id }), 'utf8').toString('base64url');
}

export function decodePageCursor(value: string): PageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') throw new Error('shape');
    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime()) || !/^[A-Za-z0-9_-]{4,120}$/.test(parsed.id)) throw new Error('value');
    return { at, id: parsed.id };
  } catch {
    throw new DomainError('INVALID_INPUT', 'Invalid pagination cursor');
  }
}

export interface MemberPageCursor { readonly email: string; readonly id: string }

export function encodeMemberCursor(email: string, id: string): string {
  return Buffer.from(JSON.stringify({ email, id }), 'utf8').toString('base64url');
}

export function decodeMemberCursor(value: string): MemberPageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { email?: unknown; id?: unknown };
    if (typeof parsed.email !== 'string' || typeof parsed.id !== 'string') throw new Error('shape');
    if (!parsed.email.length || parsed.email.length > 320 || !/^[A-Za-z0-9_-]{4,120}$/.test(parsed.id)) throw new Error('value');
    return { email: parsed.email, id: parsed.id };
  } catch {
    throw new DomainError('INVALID_INPUT', 'Invalid pagination cursor');
  }
}
