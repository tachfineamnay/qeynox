import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './transport/domain-exception.filter';

async function bootstrap() {
  // abortOnError must stay disabled so a provider/configuration failure is reported by this
  // catch instead of Nest silently calling process.exit(1) with no diagnostic.
  // MISSION A08 — rawBody. A provider webhook signature covers the exact bytes that were sent, so the
  // application must be able to verify those bytes rather than a re-serialised object. Capturing them
  // is what makes signature verification meaningful; without it the webhook route refuses every event.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false, rawBody: true });
  app.useGlobalFilters(new DomainExceptionFilter());
  // The webhook route needs the untouched body; every other route keeps normal JSON parsing.
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 4000), '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error('QeyNox API bootstrap failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
