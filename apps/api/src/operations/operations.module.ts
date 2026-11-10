import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { provideStore, provideOperations, provideExecution, providePlanning, provideResults } from './operations.provider';
@Module({
  controllers:[OperationsController],
  providers:[provideStore,provideOperations,provideExecution,providePlanning,provideResults],
})
export class OperationsModule {}
