import type { PlatformPrincipal } from '@qeynox/domain';

export interface PlatformRequest {
  headers: Record<string, string | string[] | undefined>;
  platformPrincipal?: PlatformPrincipal;
}
