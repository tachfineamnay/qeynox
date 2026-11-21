import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { DomainError, requireId, type Principal } from '@qeynox/domain';
import { AtlasLibraryService } from '@qeynox/application';
import { PublicRoute } from '../auth/public-route';
import { ATLAS_LIBRARY_SERVICE } from './results.tokens';

interface AuthedRequest {
  principal?: Principal;
}

@Controller('v1')
export class AtlasLibraryController {
  constructor(@Inject(ATLAS_LIBRARY_SERVICE) private readonly library: AtlasLibraryService) {}

  @Get('results')
  list(@Req() req: AuthedRequest, @Query() query: Record<string, unknown>) {
    if (!req.principal) throw new DomainError('DENIED', 'Workspace required');
    return this.library.listLibrary(req.principal, query);
  }

  @Get('results/:documentId')
  detail(
    @Req() req: AuthedRequest,
    @Param('documentId') documentId: string,
    @Query('compareWith') compareWith?: string,
  ) {
    if (!req.principal) throw new DomainError('DENIED', 'Workspace required');
    const compareId =
      typeof compareWith === 'string' && compareWith.trim().length > 0
        ? requireId(compareWith.trim())
        : undefined;
    return this.library.getDetail(req.principal, requireId(documentId), compareId);
  }

  @Get('results/:documentId/shares')
  listShares(@Req() req: AuthedRequest, @Param('documentId') documentId: string) {
    if (!req.principal) throw new DomainError('DENIED', 'Workspace required');
    return this.library.listShares(req.principal, requireId(documentId));
  }

  @Post('results/:documentId/shares')
  createShare(
    @Req() req: AuthedRequest,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    if (!req.principal) throw new DomainError('DENIED', 'Workspace required');
    return this.library.createShare(req.principal, requireId(documentId), body);
  }

  @Post('results/:documentId/shares/:shareId/revoke')
  revokeShare(
    @Req() req: AuthedRequest,
    @Param('documentId') documentId: string,
    @Param('shareId') shareId: string,
  ) {
    if (!req.principal) throw new DomainError('DENIED', 'Workspace required');
    return this.library.revokeShare(req.principal, requireId(documentId), requireId(shareId));
  }

  @PublicRoute()
  @Get('public/shared-results/:token')
  sharedResult(@Param('token') token: string) {
    return this.library.resolveSharedResult(token);
  }
}
