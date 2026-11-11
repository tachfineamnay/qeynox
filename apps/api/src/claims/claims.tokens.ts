/** DI tokens live in a controller-free module to avoid ESM cycles with NestJS controllers. */
export const CLAIMS_SERVICE = Symbol('CLAIMS_SERVICE');
