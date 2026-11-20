import { Body, Controller, Get, Headers, Inject, Param, Post, Req, RawBodyRequest } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, requireId, type Principal } from '@qeynox/domain';
import { PaymentService } from '@qeynox/application';
import { PublicRoute } from '../auth/public-route';
import { PAYMENT_SERVICE } from './commerce.tokens';

/**
 * MISSION A08 — payment surface.
 *
 * Two kinds of route live here and they authenticate differently on purpose:
 * - the webhook is PUBLIC (the provider has no QeyNox session) but is authenticated by its signature,
 *   which is strictly stronger than a shared secret in a header;
 * - every customer route requires a workspace session and is scoped to one operation and order.
 *
 * There is deliberately NO route that marks a payment as paid from a redirect. A return-from-provider
 * page may read, never write.
 */
interface Authed { principal?: Principal }
interface RawRequest extends Authed { rawBody?: Buffer }

const startCheckout = z.object({
  orderId: z.string().min(4),
  idempotencyKey: z.string().min(8).max(200),
  successUrl: z.string().url().max(2000),
  cancelUrl: z.string().url().max(2000),
  expiresInSeconds: z.number().int().min(300).max(24 * 3600).optional(),
});
const capture = z.object({ orderId: z.string().min(4), idempotencyKey: z.string().min(8).max(200) });
const refund = z.object({
  orderId: z.string().min(4), amountMinor: z.number().int().positive(),
  reason: z.string().min(3).max(500), idempotencyKey: z.string().min(8).max(200),
});

@Controller()
export class PaymentsController {
  constructor(@Inject(PAYMENT_SERVICE) private readonly payments: PaymentService) {}

  @PublicRoute()
  @Post('v1/payments/webhook/stripe')
  async stripeWebhook(
    @Req() request: RawRequest,
    @Headers('stripe-signature') signature: string | undefined,
    @Body() body: unknown,
  ) {
    // The signature covers the exact bytes the provider sent. NestJS can only hand those back when raw
    // body capture is enabled; if it is not, we refuse rather than verify a re-serialised payload.
    const raw = request.rawBody;
    if (!raw || raw.length === 0) throw new DomainError('INVALID_INPUT', 'Raw webhook body is unavailable');
    if (!signature) throw new DomainError('DENIED', 'Missing Stripe signature');
    void body;
    const result = await this.payments.handleWebhook(signature, new Uint8Array(raw), '');
    // A duplicate is a success from the provider's point of view: it must stop retrying.
    return { received: true, ...result };
  }

  /** Customer-visible payment status for the current plan revision. */
  @Get('v1/operations/:operationId/payment')
  view(@Req() request: Authed, @Param('operationId') operationId: string) {
    if (!request.principal) throw new DomainError('DENIED', 'Session required');
    return this.payments.view(request.principal, requireId(operationId));
  }

  /** Starts or safely resumes checkout. Idempotent on the supplied key. */
  @Post('v1/operations/:operationId/payments/checkout')
  async checkout(@Req() request: Authed, @Param('operationId') operationId: string, @Body() body: unknown) {
    if (!request.principal) throw new DomainError('DENIED', 'Session required');
    const input = startCheckout.parse(body);
    return this.payments.startCheckout(
      request.principal, requireId(operationId), requireId(input.orderId), input.idempotencyKey,
      { successUrl: input.successUrl, cancelUrl: input.cancelUrl }, input.expiresInSeconds,
    );
  }

  /**
   * Customer returned from the provider page.
   *
   * Reads the provider and reports status. It writes no state, so a hand-crafted return URL cannot
   * authorize execution. A redirect is a navigation event, not evidence.
   */
  @Get('v1/operations/:operationId/payments/return')
  async returned(@Req() request: Authed, @Param('operationId') operationId: string, @Headers('x-order-id') orderId: string | undefined) {
    if (!request.principal) throw new DomainError('DENIED', 'Session required');
    if (!orderId) throw new DomainError('INVALID_INPUT', 'Order reference required');
    return this.payments.confirmReturn(request.principal, requireId(operationId), requireId(orderId));
  }

  @Post('v1/operations/:operationId/payments/capture')
  capture(@Req() request: Authed, @Param('operationId') operationId: string, @Body() body: unknown) {
    if (!request.principal) throw new DomainError('DENIED', 'Session required');
    const input = capture.parse(body);
    return this.payments.capture(request.principal, requireId(operationId), requireId(input.orderId), input.idempotencyKey);
  }

  @Post('v1/operations/:operationId/payments/refund')
  refund(@Req() request: Authed, @Param('operationId') operationId: string, @Body() body: unknown) {
    if (!request.principal) throw new DomainError('DENIED', 'Session required');
    const input = refund.parse(body);
    return this.payments.refund(
      request.principal, requireId(operationId), requireId(input.orderId), input.amountMinor, input.reason, input.idempotencyKey,
    );
  }

  /** Operator-triggered reconciliation against the provider of record. */
  @Post('v1/operations/:operationId/payments/reconcile')
  reconcile(@Req() request: Authed, @Param('operationId') operationId: string, @Body() body: unknown) {
    if (!request.principal) throw new DomainError('DENIED', 'Session required');
    const input = capture.parse(body);
    return this.payments.reconcileOrder(request.principal, requireId(operationId), requireId(input.orderId));
  }
}
