import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthenticationGuard } from './auth.guard';
@Module({
  providers:[AuthService,{provide:APP_GUARD,useClass:AuthenticationGuard}],
  controllers:[AuthController],
  exports:[AuthService],
})
export class AuthModule {}
