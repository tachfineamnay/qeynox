import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { ClaimsService } from '@qeynox/application';
import { QEYNOX_STORE } from '../database/database.module';
import { ClaimsController } from './claims.controller';
export const CLAIMS_SERVICE=Symbol('CLAIMS_SERVICE');
@Module({controllers:[ClaimsController],providers:[{provide:CLAIMS_SERVICE,useFactory:(s:QeyNoxStore)=>new ClaimsService(s),inject:[QEYNOX_STORE]}]})
export class ClaimsModule {}
