import { DomainError } from './errors';
import { newId } from './identities';
import type { ID } from './identities';
import type { Artifact, Evidence, ResultVersion } from './entities';

export function assembleResult(input: {
  workspaceId: ID; operationId: ID; revisionId: ID; version: number; title: string;
  summary: string; evidence: readonly Evidence[]; artifacts: readonly Artifact[];
  gaps?: readonly string[]; prior?: ResultVersion; now: string;
}): ResultVersion {
  if (!input.title.trim()) throw new DomainError('INVALID_INPUT', 'Result requires title');
  for (const e of input.evidence) if (e.operationId !== input.operationId) throw new DomainError('DENIED', 'Cross-operation evidence');
  for (const a of input.artifacts) if (a.workspaceId !== input.workspaceId || a.operationId !== input.operationId) throw new DomainError('DENIED', 'Cross-operation artifact');
  const gaps = [...(input.gaps ?? [])];
  if (input.evidence.length === 0) gaps.push('No supporting evidence recorded');
  if (input.evidence.some(e => e.status !== 'VERIFIED')) gaps.push('Some claims are unverified, stale or disputed');
  if (input.prior && (input.prior.operationId !== input.operationId || input.version <= input.prior.version)) throw new DomainError('CONFLICT', 'Invalid result lineage');
  return {
    id: newId(), workspaceId: input.workspaceId, operationId: input.operationId,
    revisionId: input.revisionId, version: input.version, title: input.title,
    summary: input.summary, evidenceIds: input.evidence.map(e => e.id), artifactIds: input.artifacts.map(a => a.id),
    status: gaps.length ? 'DRAFT' : 'DELIVERABLE', gaps, createdAt: input.now, supersedesResultId: input.prior?.id,
  };
}
