/** DI token lives outside controllers to avoid ESM cycles with NestJS controllers. */
export const CAPABILITY_CATALOGUE = Symbol('CAPABILITY_CATALOGUE');
