import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { RecoveryService } from '@qeynox/application';
import { QEYNOX_STORE } from '../database/database.module';
import { OperatorController } from './operator.controller';
export const RECOVERY_SERVICE=Symbol('RECOVERY_SERVICE');
@Module({controllers:[OperatorController],providers:[{provide:RECOVERY_SERVICE,useFactory:(s:QeyNoxStore)=>new RecoveryService(s),inject:[QEYNOX_STORE]}]})
export class OperatorModule {}
