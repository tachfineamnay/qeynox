import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthenticationGuard } from './auth.guard';
import { IdentityLifecycleApiService } from './identity-lifecycle.service';
import { IdentityController } from './identity.controller';
import { EMAIL_TRANSPORT } from '../platform/platform.tokens';
import { createEmailTransport } from '../platform/email-transport.provider';
import type { EmailTransport } from '@qeynox/application';

function providers(transportProvider: Provider): Provider[] {
  return [
    AuthService,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    transportProvider,
    IdentityLifecycleApiService,
  ];
}

/**
 * Workspace authentication and the customer identity lifecycle.
 *
 * The e-mail transport is `createEmailTransport()`, driven by QEYNOX_EMAIL_PROVIDER. A real
 * adapter exists ('resend'); any missing, incomplete or unrecognized configuration fails closed to
 * NOT_CONFIGURED, so verification and recovery links are never claimed to be delivered unless the
 * provider actually accepted them. Delivery outcomes are recorded in the email_deliveries ledger.
 */
@Module({
  providers: providers({ provide: EMAIL_TRANSPORT, useFactory: () => createEmailTransport(), inject: [] }),
  controllers: [AuthController, IdentityController],
  exports: [AuthService, IdentityLifecycleApiService, EMAIL_TRANSPORT],
})
export class AuthModule {
  /**
   * The same auth/identity surface with an explicitly supplied transport.
   *
   * Used ONLY by isolated QA to exercise the CONFIGURED branch with a transport that performs no
   * network I/O. It is a separate module rather than an option on the decorator so that production
   * wiring stays a single static graph: nothing in the application can ask for an override, and the
   * module deliberately does not export a second `APP_GUARD` instance.
   */
  static forTest(transport: EmailTransport): DynamicModule {
    return {
      module: AuthModule,
      providers: [AuthService, { provide: EMAIL_TRANSPORT, useValue: transport }, IdentityLifecycleApiService],
      controllers: [AuthController, IdentityController],
      exports: [AuthService, IdentityLifecycleApiService, EMAIL_TRANSPORT],
    };
  }
}
