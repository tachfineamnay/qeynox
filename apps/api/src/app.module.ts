import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { OperationsModule } from './operations/operations.module';
import { ClaimsModule } from './claims/claims.module';
import { ResultsModule } from './results/results.module';
import { CommerceModule } from './commerce/commerce.module';
import { ActivityModule } from './activity/activity.module';
@Module({imports:[DatabaseModule,AuthModule,OperationsModule,ClaimsModule,ResultsModule,CommerceModule,ActivityModule]})
export class AppModule {}
