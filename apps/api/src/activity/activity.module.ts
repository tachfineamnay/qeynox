import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { OperationReadModels } from '@qeynox/application';
import { QEYNOX_STORE } from '../database/database.module';
import { ActivityController } from './activity.controller';
export const OPERATION_READMODELS=Symbol('OPERATION_READMODELS');
@Module({controllers:[ActivityController],providers:[{provide:OPERATION_READMODELS,useFactory:(s:QeyNoxStore)=>new OperationReadModels(s),inject:[QEYNOX_STORE]}]})
export class ActivityModule {}
