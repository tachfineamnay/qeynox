export type ID = string & { readonly __brand: unique symbol };
export const newId = (): ID => crypto.randomUUID() as ID;
export function requireId(value: string): ID {
  if (!/^[a-zA-Z0-9_-]{4,120}$/.test(value)) throw new Error('Invalid ID format');
  return value as ID;
}
