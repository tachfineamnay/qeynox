import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, type Principal } from '@qeynox/domain';
import {
  ServiceCatalogueService,
  resolveContract,
  type ServiceContractRegistry,
} from '@qeynox/application';
import {
  serviceRequestEnvelopeSchema,
  type ServiceDetail,
  type ServiceRequestResult,
  type ServiceSummary,
} from '@qeynox/contracts';
import { SERVICES_CATALOGUE, SERVICES_CONTRACTS } from './services.tokens';

interface Request { principal?: Principal }
const offerIdSchema = z.string().min(4).max(120).regex(/^[A-Za-z0-9_.:-]+$/);

function principal(request: Request): Principal {
  if (!request.principal) throw new DomainError('DENIED', 'Session required');
  return request.principal;
}

/**
 * MISSION A13 — customer service catalogue.
 *
 * Read surface for the customer Web app. The catalogue lists ACTIVE, operator-published offers with
 * their real availability; a request creates the operation and the bounded plan through the typed
 * contract registered for the offer. Nothing here is generated, auto-approved or silently widened:
 * the customer still reviews the plan, quotes and accepts the scope — and execution stays gated by
 * the existing readiness, budget and approval machinery.
 */
@Controller('v1/services')
export class ServicesController {
  constructor(
    @Inject(SERVICES_CATALOGUE) private readonly catalogue: ServiceCatalogueService,
    @Inject(SERVICES_CONTRACTS) private readonly contracts: ServiceContractRegistry | null,
  ) {}

  @Get()
  list(@Req() request: Request): Promise<ServiceSummary[]> {
    return this.catalogue.list(principal(request));
  }

  @Get(':offerId')
  async detail(@Req() request: Request, @Param('offerId') offerId: string): Promise<ServiceDetail> {
    const view = await this.catalogue.detail(principal(request), offerIdSchema.parse(offerId));
    if (!view) throw new DomainError('NOT_FOUND', 'Service not found');
    return view;
  }

  /**
   * The request → operation → plan step of the customer journey. Quoting, acceptance, payment and
   * launch are NOT performed here: they stay on the existing mission flow. The response carries the
   * operation id (deep link to the mission workspace), the plan revision id and the deterministic
   * fingerprint of the normalized request.
   */
  @Post(':offerId/requests')
  async request(@Req() request: Request, @Param('offerId') offerId: string, @Body() body: unknown): Promise<ServiceRequestResult> {
    const actor = principal(request);
    const id = offerIdSchema.parse(offerId);
    const envelope = serviceRequestEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      throw new DomainError('INVALID_INPUT', 'The service request does not match the expected contract envelope');
    }
    const detail = await this.catalogue.detail(actor, id);
    if (!detail) throw new DomainError('NOT_FOUND', 'Service not found');
    const { contract } = resolveContract(this.contracts, id, detail.capabilityIds);
    if (!contract) {
      throw new DomainError('NOT_CONFIGURED', 'This deployment has no registered request contract for this service (' + (detail.unavailableReason ?? 'SERVICE_NOT_CONFIGURED') + ')');
    }
    if (envelope.data.service !== contract.key) {
      throw new DomainError('INVALID_INPUT', 'The request envelope does not match the contract registered for this service');
    }
    if (!detail.requestable) {
      throw new DomainError('NOT_CONFIGURED', detail.unavailableReason ?? 'CAPABILITY_NOT_CONFIGURED');
    }
    const created = await contract.create(actor, envelope.data.input);
    return {
      operationId: created.operationId,
      revisionId: created.revisionId,
      fingerprint: created.fingerprint,
      warnings: [...created.warnings],
      stepCount: created.stepCount,
    };
  }
}
