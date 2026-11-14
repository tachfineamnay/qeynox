import { Controller, Get, Inject, Req } from '@nestjs/common';
import { DomainError } from '@qeynox/domain';
import type { PlatformCatalogueService } from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { PLATFORM_CATALOGUE_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

/** Read-only business capability catalogue and deployment prerequisites for Control. */
@PlatformRoute()
@Controller('v1/platform')
export class PlatformCatalogueController {
  constructor(@Inject(PLATFORM_CATALOGUE_SERVICE) private readonly catalogue: PlatformCatalogueService) {}

  @PlatformAccess('CONSULTATION')
  @Get('capabilities')
  read(@Req() request: PlatformRequest) {
    if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
    return this.catalogue.read(request.platformPrincipal);
  }
}
