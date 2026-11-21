import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, type Principal } from '@qeynox/domain';
import { DocumentVaultService, DOCUMENT_ALLOWED_CONTENT_TYPES, DOCUMENT_MAX_BYTES } from '@qeynox/application';
import { DOCUMENT_VAULT } from './documents.tokens';

/**
 * MISSION A17 — customer document vault HTTP surface.
 *
 * POST   /v1/documents/begin                      — declare metadata; returns a presigned single-PUT URL
 * POST   /v1/documents/:id/complete               — verify stored bytes (size + SHA-256) and enqueue ingest
 * GET    /v1/documents                            — workspace listing (never content)
 * GET    /v1/documents/:id                        — metadata + ingestion state
 * GET    /v1/documents/:id/download               — short-lived signed read URL
 * POST   /v1/documents/search                     — tenant-scoped FTS (+ optional hybrid rerank)
 * DELETE /v1/documents/:id                        — revoke everywhere (object + rows + audit)
 * POST   /v1/operations/:operationId/documents/:documentId/attach   — attach to mission
 * POST   /v1/operations/:operationId/documents/:documentId/detach   — detach
 * GET    /v1/operations/:operationId/vault-documents              — vault documents attached to the mission
 *
 * Uploading is the explicit consent act: a purpose statement is required and retained.
 * No endpoint returns document bytes; every read path is workspace-scoped and membership-gated.
 */
interface Authed { principal?: Principal }
const principal = (request: Authed): Principal => {
  if (!request.principal) throw new DomainError('DENIED', 'Session required');
  return request.principal;
};

const begin = z.object({
  name: z.string().trim().min(1).max(200),
  contentType: z.enum(DOCUMENT_ALLOWED_CONTENT_TYPES as unknown as [string, ...string[]]),
  sizeBytes: z.number().int().min(1).max(DOCUMENT_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  purpose: z.string().trim().min(3).max(300),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});
const search = z.object({ query: z.string().trim().min(2).max(300), limit: z.number().int().min(1).max(20).optional() });
const idSchema = z.string().min(4).max(64).regex(/^[A-Za-z0-9_-]+$/);

@Controller()
export class DocumentsController {
  constructor(@Inject(DOCUMENT_VAULT) private readonly documents: DocumentVaultService) {}

  @Post('v1/documents/begin')
  async beginUpload(@Req() request: Authed, @Body() body: unknown) {
    const actor = principal(request);
    const input = begin.parse(body);
    return this.documents.beginUpload(actor, input);
  }

  @Post('v1/documents/:id/complete')
  async complete(@Req() request: Authed, @Param('id') id: string) {
    const actor = principal(request);
    const result = await this.documents.completeUpload(actor, idSchema.parse(id));
    // Best-effort same-process drain; the worker polls the durable job table as the real guarantee.
    setImmediate(() => {
      void this.documents.drainIngestPending({ workspaceId: actor.workspaceId, limit: 5 }).catch(() => undefined);
    });
    return result;
  }

  @Get('v1/documents')
  list(@Req() request: Authed) {
    return this.documents.list(principal(request));
  }

  @Get('v1/documents/:id')
  get(@Req() request: Authed, @Param('id') id: string) {
    return this.documents.get(principal(request), idSchema.parse(id));
  }

  @Get('v1/documents/:id/download')
  download(@Req() request: Authed, @Param('id') id: string) {
    return this.documents.signedDownload(principal(request), idSchema.parse(id));
  }

  @Post('v1/documents/search')
  searchDocuments(@Req() request: Authed, @Body() body: unknown) {
    const input = search.parse(body);
    return this.documents.search(principal(request), input.query, input.limit);
  }

  @Delete('v1/documents/:id')
  async remove(@Req() request: Authed, @Param('id') id: string) {
    // P12: access is revoked now; `storage` is DELETED only when the object was verified absent,
    // otherwise PENDING (a durable intent retries it). `ok` keeps the existing contract.
    const result = await this.documents.delete(principal(request), idSchema.parse(id));
    return { ok: true, storage: result.storage };
  }

  @Post('v1/operations/:operationId/documents/:documentId/attach')
  async attach(@Req() request: Authed, @Param('operationId') operationId: string, @Param('documentId') documentId: string) {
    await this.documents.attach(principal(request), idSchema.parse(documentId), idSchema.parse(operationId));
    return { ok: true };
  }

  @Post('v1/operations/:operationId/documents/:documentId/detach')
  async detach(@Req() request: Authed, @Param('operationId') operationId: string, @Param('documentId') documentId: string) {
    await this.documents.detach(principal(request), idSchema.parse(documentId), idSchema.parse(operationId));
    return { ok: true };
  }

  @Get('v1/operations/:operationId/vault-documents')
  attached(@Req() request: Authed, @Param('operationId') operationId: string) {
    return this.documents.attachedDocuments(principal(request), idSchema.parse(operationId));
  }
}
