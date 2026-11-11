/** DI tokens live in a controller-free module to avoid ESM cycles with NestJS controllers. */
export const OPERATION_READMODELS = Symbol('OPERATION_READMODELS');
