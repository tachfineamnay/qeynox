/** DI tokens live in a controller-free module to avoid ESM cycles with NestJS controllers. */
export const RESULT_ASSEMBLER = Symbol('RESULT_ASSEMBLER');
export const ARTIFACT_DELIVERY = Symbol('ARTIFACT_DELIVERY');
export const RESULT_DELIVERY = Symbol('RESULT_DELIVERY');
