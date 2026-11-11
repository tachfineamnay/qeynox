/** DI tokens live in a controller-free module to avoid ESM cycles with NestJS controllers. */
export const COMMERCE_SERVICE = Symbol('COMMERCE_SERVICE');
