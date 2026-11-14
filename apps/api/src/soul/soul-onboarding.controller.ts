import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, SOUL_ONBOARDING_STEPS, type Principal } from '@qeynox/domain';
import type { SoulOnboardingService } from '@qeynox/roles';
import { SOUL_ONBOARDING_SERVICE } from './soul.tokens';

interface Request { principal?: Principal }

const stepSchema = z.enum(SOUL_ONBOARDING_STEPS);
const startSchema = z.object({ locale: z.enum(['en', 'fr']).optional() });
const answerSchema = z.object({
  step: stepSchema,
  value: z.union([
    z.string().trim().min(1).max(500),
    z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  ]),
});
const skipSchema = z.object({ step: stepSchema });
const consentSchema = z.object({ granted: z.boolean() });
const completeSchema = z.object({ objective: z.string().trim().min(5).max(500).optional() });

function principal(request: Request): Principal {
  if (!request.principal?.workspaceId || !request.principal.userId) throw new DomainError('DENIED', 'Authenticated workspace required');
  return request.principal;
}

/**
 * Pre-mission Soul onboarding contract.
 *
 * The existing /v1/soul/converse endpoint stays untouched: it requires a real operationId and
 * attemptId, which must never be invented. Onboarding therefore exposes its own deterministic,
 * operation-free contract. No language model is invoked; every response is explicitly marked
 * deterministic (PRE_MISSION_CONTRACT) rather than pretending to be an LLM conversation.
 */
@Controller('v1/soul/onboarding')
export class SoulOnboardingController {
  constructor(@Inject(SOUL_ONBOARDING_SERVICE) private readonly onboarding: SoulOnboardingService) {}

  @Get()
  view(@Req() request: Request) { return this.onboarding.view(principal(request)); }

  @Post('start')
  start(@Req() request: Request, @Body() body: unknown) {
    return this.onboarding.start(principal(request), startSchema.parse(body ?? {}).locale);
  }

  @Post('answer')
  answer(@Req() request: Request, @Body() body: unknown) {
    const input = answerSchema.parse(body);
    return this.onboarding.answer(principal(request), input.step, input.value);
  }

  @Post('skip')
  skip(@Req() request: Request, @Body() body: unknown) {
    return this.onboarding.skip(principal(request), skipSchema.parse(body).step);
  }

  @Post('consent')
  consent(@Req() request: Request, @Body() body: unknown) {
    return this.onboarding.grantOnboardingConsent(principal(request), consentSchema.parse(body).granted);
  }

  @Post('pause')
  pause(@Req() request: Request) { return this.onboarding.pause(principal(request)); }

  @Post('resume')
  resume(@Req() request: Request) { return this.onboarding.resume(principal(request)); }

  @Post('dismiss')
  dismiss(@Req() request: Request) { return this.onboarding.dismiss(principal(request)); }

  @Post('complete')
  complete(@Req() request: Request, @Body() body: unknown) {
    return this.onboarding.complete(principal(request), completeSchema.parse(body ?? {}).objective);
  }

  @Post('mission')
  createMission(@Req() request: Request, @Body() body: unknown) {
    const input = z.object({ objective: z.string().trim().min(5).max(500) }).parse(body);
    return this.onboarding.createFirstMission(principal(request), input.objective);
  }
}
