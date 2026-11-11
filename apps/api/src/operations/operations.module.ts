import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { provideOperations,provideExecution,providePlanning,provideResults } from './operations.provider';
@Module({controllers:[OperationsController],providers:[provideOperations,provideExecution,providePlanning,provideResults]})
export class OperationsModule {}
