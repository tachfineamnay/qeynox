import { Module } from '@nestjs/common';
import { OperationsModule } from './operations/operations.module';

@Module({ imports: [OperationsModule] })
export class AppModule {}
