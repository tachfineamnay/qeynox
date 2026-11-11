/** Agent runtime DI tokens live outside controllers to avoid ESM cycles. */
export const ENGINE_PORT = Symbol('ENGINE_PORT');
export const AGENT_PROFILES = Symbol('AGENT_PROFILES');
