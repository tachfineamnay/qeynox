import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { OperationsModule } from './operations/operations.module';
import { ClaimsModule } from './claims/claims.module';
@Module({imports:[DatabaseModule,AuthModule,OperationsModule,ClaimsModule]})
export class AppModule {}
