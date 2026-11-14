import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { ZodError, z } from 'zod';
import { DomainError, type PlatformPrincipal } from '@qeynox/domain';
import type { PlatformAdminService, PlatformLoginResult, PlatformSessionInfo } from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { PLATFORM_ADMIN_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(256) });

function principal(request: PlatformRequest): PlatformPrincipal {
  if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
  return request.platformPrincipal;
}

@PlatformRoute()
@Controller('v1/platform/auth')
export class PlatformAuthController {
  constructor(@Inject(PLATFORM_ADMIN_SERVICE) private readonly platform: PlatformAdminService) {}

  /** Platform-only sign-in. A workspace session is never accepted here. */
  @PlatformAccess('PUBLIC_LOGIN')
  @Post('login')
  async login(@Body() body: unknown): Promise<PlatformLoginResult> {
    let input: z.infer<typeof loginSchema>;
    try {
      input = loginSchema.parse(body);
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        await this.platform.recordAccessDenial({ action: 'LOGIN', targetType: 'IDENTITY_ACCOUNT', reason: 'INVALID_INPUT' });
      }
      throw error;
    }
    return this.platform.login(input);
  }

  @PlatformAccess('SELF')
  @Post('logout')
  logout(@Req() request: PlatformRequest): Promise<{ revoked: true }> {
    return this.platform.logout(principal(request));
  }

  @PlatformAccess('SELF')
  @Get('me')
  me(@Req() request: PlatformRequest): PlatformSessionInfo {
    return this.platform.me(principal(request));
  }
}
