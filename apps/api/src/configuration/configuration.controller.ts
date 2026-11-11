import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { applyConfigurationSchema } from '@qeynox/contracts';
import { ConfigurationService } from '@qeynox/application';
import { DomainError, type Principal } from '@qeynox/domain';
import { CONFIGURATION_SERVICE } from './configuration.module';
interface Request { principal?: Principal }
/**
 * Global product configuration is restricted to an explicitly allowlisted deployment operator
 * (QEYNOX_OPERATOR_USER_IDS) with an operator workspace role. When the allowlist is unset every
 * route fails closed with NOT_CONFIGURED.
 */
@Controller('v1/operator/configuration')
export class ConfigurationController {
  constructor(@Inject(CONFIGURATION_SERVICE) private readonly configuration: ConfigurationService) {}
  @Get()
  state(@Req() request: Request) {
    if (!request.principal) throw new DomainError('DENIED', 'Session required');
    return this.configuration.state(request.principal);
  }
  @Post('apply')
  apply(@Req() request: Request, @Body() body: unknown) {
    if (!request.principal) throw new DomainError('DENIED', 'Session required');
    return this.configuration.apply(request.principal, applyConfigurationSchema.parse(body));
  }
}
