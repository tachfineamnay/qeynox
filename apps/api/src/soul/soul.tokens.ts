/** DI tokens live in a controller-free module to avoid ESM cycles with NestJS controllers. */
export const SOUL_SERVICE = Symbol('SOUL_SERVICE');
