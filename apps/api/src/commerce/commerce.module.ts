import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { CommerceService, createFrozenPaymentGateway } from '@qeynox/application';
import { QEYNOX_STORE } from '../database/database.module';
import { CommerceController } from './commerce.controller';
import { PaymentsController } from './payments.controller';
import { COMMERCE_SERVICE, PAYMENT_SERVICE } from './commerce.tokens';

/**
 * MISSION A21.01 — HARD PAYMENT FREEZE (supersedes the A08 key-presence wiring).
 *
 * Before A21.01 the presence of `QEYNOX_STRIPE_SECRET_KEY` + `QEYNOX_STRIPE_WEBHOOK_SECRET` was itself
 * the activation switch for Stripe. That switch is removed. The payment surface is now composed from
 * `QEYNOX_COMMERCE_MODE` alone (`PAYMENTS_DISABLED` by default, or `BETA_FREE`), and both modes freeze
 * every payment mutation. The Stripe credentials are not read here, so configuring them changes nothing:
 * `StripePaymentProvider` is never constructed and no Stripe API is reachable from this process.
 *
 * An unsupported mode value (any attempt at a paid mode) throws at module creation. That stops the API
 * from booting with an ambiguous commercial posture, which is the intended fail-closed behaviour.
 *
 * The Stripe adapter and the A08 paid lifecycle remain in `@qeynox/application`, unchanged and covered
 * by `qa:stripe-payments`, for a future, separately reviewed reactivation.
 */
@Module({
  controllers: [CommerceController, PaymentsController],
  providers: [
    { provide: COMMERCE_SERVICE, useFactory: (store: QeyNoxStore) => new CommerceService(store), inject: [QEYNOX_STORE] },
    {
      provide: PAYMENT_SERVICE,
      useFactory: (store: QeyNoxStore) => createFrozenPaymentGateway(store, process.env),
      inject: [QEYNOX_STORE],
    },
  ],
})
export class CommerceModule {}
