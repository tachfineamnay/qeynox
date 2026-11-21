/** DI tokens live in a controller-free module to avoid ESM cycles with NestJS controllers. */
export const RESULT_ASSEMBLER = Symbol('RESULT_ASSEMBLER');
export const ARTIFACT_STORE_PORT = Symbol('ARTIFACT_STORE_PORT');
export const ARTIFACT_DELIVERY = Symbol('ARTIFACT_DELIVERY');
export const RESULT_DELIVERY = Symbol('RESULT_DELIVERY');
export const ATLAS_LIBRARY_SERVICE = Symbol('ATLAS_LIBRARY_SERVICE');
