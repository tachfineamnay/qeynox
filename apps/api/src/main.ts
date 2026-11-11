import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './transport/domain-exception.filter';

async function bootstrap() {
  // abortOnError must stay disabled so a provider/configuration failure is reported by this
  // catch instead of Nest silently calling process.exit(1) with no diagnostic.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false });
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 4000), '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error('QeyNox API bootstrap failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
