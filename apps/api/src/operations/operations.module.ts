import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { provideOperations,provideExecution,providePlanning,provideControls,provideRevisions,providePlanRead,provideInterruption } from './operations.provider';
@Module({controllers:[OperationsController],providers:[provideOperations,provideExecution,providePlanning,provideControls,provideRevisions,providePlanRead,provideInterruption]})
export class OperationsModule {}

