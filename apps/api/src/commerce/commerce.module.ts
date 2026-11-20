import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import {
  CommerceService, CompositePaymentProvider, DisabledPaymentProvider, PaymentService, StripePaymentProvider,
  type PaymentPort,
} from '@qeynox/application';
import { QEYNOX_STORE } from '../database/database.module';
import { CommerceController } from './commerce.controller';
import { PaymentsController } from './payments.controller';
import { COMMERCE_SERVICE, PAYMENT_SERVICE } from './commerce.tokens';

/**
 * MISSION A08 — provider wiring.
 *
 * The disabled provider is the default in every environment. Stripe is constructed ONLY when a
 * test-mode secret key and a webhook secret are both present; the adapter itself additionally refuses
 * any key that is not a test-mode key, so a live key pasted into a development environment fails at
 * construction instead of charging a customer.
 *
 * The configuration is read once at module creation. Changing it requires a restart, which is the
 * intended behaviour: a payment provider that silently switches under a running process is worse than
 * one that needs a deploy.
 */
function createPaymentProvider(): CompositePaymentProvider {
  const disabled = new DisabledPaymentProvider();
  const secretKey = process.env.QEYNOX_STRIPE_SECRET_KEY ?? '';
  const webhookSecret = process.env.QEYNOX_STRIPE_WEBHOOK_SECRET ?? '';
  // Explicit opt-in is not required: the presence of BOTH credentials is the configuration.
  if (!secretKey || !webhookSecret) return new CompositePaymentProvider(undefined, disabled);
  try {
    const provider: PaymentPort = new StripePaymentProvider({ secretKey, webhookSecret });
    return new CompositePaymentProvider(provider, disabled);
  } catch (error: unknown) {
    // A misconfigured provider must not fall back to a working-but-wrong mode. It also must not stop the
    // API from booting: an unreachable payment provider should surface as PAYMENT_NOT_CONFIGURED on the
    // payment routes, not as a dead process for every other feature.
    console.error('QeyNox payment provider rejected configuration:', error instanceof Error ? error.message : 'unknown error');
    return new CompositePaymentProvider(undefined, disabled);
  }
}

@Module({
  controllers: [CommerceController, PaymentsController],
  providers: [
    { provide: COMMERCE_SERVICE, useFactory: (store: QeyNoxStore) => new CommerceService(store), inject: [QEYNOX_STORE] },
    {
      provide: PAYMENT_SERVICE,
      useFactory: (store: QeyNoxStore) => new PaymentService(store, createPaymentProvider()),
      inject: [QEYNOX_STORE],
    },
  ],
})
export class CommerceModule {}
