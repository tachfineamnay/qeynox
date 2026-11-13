import { Controller, Get } from '@nestjs/common';
import { PublicRoute } from './auth/public-route';

@Controller('health')
export class HealthController {
  @PublicRoute()
  @Get()
  live() { return { status: 'alive' }; }
}
