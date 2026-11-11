import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { provideOperations,provideExecution,providePlanning,provideControls,provideRevisions } from './operations.provider';
@Module({controllers:[OperationsController],providers:[provideOperations,provideExecution,providePlanning,provideControls,provideRevisions]})
export class OperationsModule {}

