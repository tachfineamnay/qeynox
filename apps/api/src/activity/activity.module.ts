import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { OperationReadModels } from '@qeynox/application';
import { QEYNOX_STORE } from '../database/database.module';
import { ActivityController } from './activity.controller';
import { OPERATION_READMODELS } from './activity.tokens';
@Module({controllers:[ActivityController],providers:[{provide:OPERATION_READMODELS,useFactory:(s:QeyNoxStore)=>new OperationReadModels(s),inject:[QEYNOX_STORE]}]})
export class ActivityModule {}
