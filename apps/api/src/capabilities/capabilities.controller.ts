import { Controller, Get, Inject, Req } from '@nestjs/common';
import { DomainError, type Principal } from '@qeynox/domain';
import type { CapabilityCatalogueService } from '@qeynox/application';
import { CAPABILITY_CATALOGUE } from './capabilities.tokens';

interface Request { principal?: Principal }

/**
 * The eight configurable business capability slots and their real availability.
 * Read-only: capability and limit configuration stays on the operator path.
 */
@Controller('v1/capabilities')
export class CapabilitiesController {
  constructor(@Inject(CAPABILITY_CATALOGUE) private readonly catalogue: CapabilityCatalogueService) {}

  @Get()
  list(@Req() request: Request) {
    if (!request.principal) throw new DomainError('DENIED', 'Session required');
    return this.catalogue.list(request.principal);
  }
}
