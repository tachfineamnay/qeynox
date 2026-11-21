import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, type Principal } from '@qeynox/domain';
import {
  ServiceCatalogueService,
  resolveContract,
  type ServiceContractRegistry,
  type ServiceRequestContract,
} from '@qeynox/application';
import {
  serviceRequestEnvelopeSchema,
  type ServiceDetail,
  type ServicePreviewResult,
  type ServiceRequestEnvelope,
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
 * MISSION A13 + A16 — customer service catalogue and business capability packs.
 *
 * Read & request surface for the customer Web app. The catalogue lists ACTIVE, operator-published
 * offers with their real availability; `preview` computes the bounded plan DAG, warnings and
 * deterministic metrics without side effects; `requests` creates the workspace-scoped operation and
 * bounded plan revision (`READY`, awaiting explicit quote, approval, and launch).
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

  private async resolveValidatedEnvelope(
    actor: Principal,
    offerId: string,
    body: unknown,
  ): Promise<{ contract: ServiceRequestContract; envelope: ServiceRequestEnvelope }> {
    const id = offerIdSchema.parse(offerId);
    const envelope = serviceRequestEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      const detailText = envelope.error.issues
        .map(issue => (issue.path.map(String).join('.') || 'request') + ': ' + issue.message)
        .join('; ');
      throw new DomainError('INVALID_INPUT', 'The service request does not match the expected contract envelope: ' + detailText);
    }
    const detail = await this.catalogue.detail(actor, id);
    if (!detail) throw new DomainError('NOT_FOUND', 'Service not found');
    const { contract } = resolveContract(this.contracts, id, detail.capabilityIds);
    if (!contract) {
      throw new DomainError(
        'NOT_CONFIGURED',
        'This deployment has no registered request contract for this service (' + (detail.unavailableReason ?? 'SERVICE_NOT_CONFIGURED') + ')',
      );
    }
    if (envelope.data.service !== contract.key) {
      throw new DomainError('INVALID_INPUT', 'The request envelope does not match the contract registered for this service');
    }
    if (!detail.requestable) {
      throw new DomainError('NOT_CONFIGURED', detail.unavailableReason ?? 'CAPABILITY_NOT_CONFIGURED');
    }
    return { contract, envelope: envelope.data };
  }

  /**
   * Side-effect-free preview of the bounded execution plan, dependencies, warnings, and computed
   * metrics for a typed service request. Nothing is written to the database.
   */
  @Post(':offerId/preview')
  async preview(
    @Req() request: Request,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<ServicePreviewResult> {
    const actor = principal(request);
    const { contract, envelope } = await this.resolveValidatedEnvelope(actor, offerId, body);
    if (!contract.preview) {
      throw new DomainError('NOT_CONFIGURED', 'Preview is not available for contract ' + contract.key);
    }
    return contract.preview(envelope.input);
  }

  /**
   * The request → operation → plan step of the customer journey. Quoting, acceptance, payment and
   * launch are NOT performed here: they stay on the existing mission flow. The response carries the
   * operation id (deep link to the mission workspace), the plan revision id and the deterministic
   * fingerprint of the normalized request.
   */
  @Post(':offerId/requests')
  async request(
    @Req() request: Request,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<ServiceRequestResult> {
    const actor = principal(request);
    const { contract, envelope } = await this.resolveValidatedEnvelope(actor, offerId, body);
    const created = await contract.create(actor, envelope.input);
    return {
      operationId: created.operationId,
      revisionId: created.revisionId,
      fingerprint: created.fingerprint,
      warnings: [...created.warnings],
      stepCount: created.stepCount,
    };
  }
}
