import { Controller, Get, Header, Inject, Req } from '@nestjs/common';
import { DomainError } from '@qeynox/domain';
import type { QeyNoxStore } from '@qeynox/persistence';
import { businessProviderStatus, type PlatformAdminService } from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { QEYNOX_STORE } from '../database/database.module';
import { PLATFORM_ADMIN_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

@PlatformRoute()
@Controller('v1/platform/providers')
export class PlatformProvidersController {
  constructor(
    @Inject(QEYNOX_STORE) private readonly store: QeyNoxStore,
    @Inject(PLATFORM_ADMIN_SERVICE) private readonly platform: PlatformAdminService,
  ) {}
  @PlatformAccess('OPERATIONS')
  @Get()
  @Header('Cache-Control', 'private, no-store')
  async status(@Req() request: PlatformRequest) {
    if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
    await this.platform.requirePermission(request.platformPrincipal, 'OPERATIONS', { action: 'READ_BUSINESS_PROVIDERS', targetType: 'PROVIDERS' });
    return businessProviderStatus(this.store);
  }
}
