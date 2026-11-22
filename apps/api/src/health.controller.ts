import { Controller, Get } from '@nestjs/common';
import { PublicRoute } from './auth/public-route';

@Controller('health')
export class HealthController {
  @PublicRoute()
  @Get()
  live() { return { status: 'alive', release: { sha: process.env.QEYNOX_RELEASE_SHA ?? null, version: process.env.QEYNOX_RELEASE_VERSION ?? null } }; }
}
