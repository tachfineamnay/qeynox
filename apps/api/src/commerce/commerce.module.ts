import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { CommerceService } from '@qeynox/application';
import { QEYNOX_STORE } from '../database/database.module';
import { CommerceController } from './commerce.controller';
export const COMMERCE_SERVICE=Symbol('COMMERCE_SERVICE');
@Module({controllers:[CommerceController],providers:[{provide:COMMERCE_SERVICE,useFactory:(s:QeyNoxStore)=>new CommerceService(s),inject:[QEYNOX_STORE]}]})
export class CommerceModule {}
