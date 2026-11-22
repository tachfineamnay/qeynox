import { Controller, Get, Header, Inject, Req } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DomainError } from '@qeynox/domain';
import type { QeyNoxStore } from '@qeynox/persistence';
import { createS3ArtifactStoreFromEnv, documentMaintenanceConfiguration, storageConfiguration, type PlatformAdminService } from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { QEYNOX_STORE } from '../database/database.module';
import { PLATFORM_ADMIN_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

/** Read-only operator diagnostics. No retry/reset/delete/signing endpoint and no object content/keys. */
@PlatformRoute()
@Controller('v1/platform/storage')
export class PlatformStorageController {
  constructor(
    @Inject(QEYNOX_STORE) private readonly store: QeyNoxStore,
    @Inject(PLATFORM_ADMIN_SERVICE) private readonly platform: PlatformAdminService,
  ) {}

  @PlatformAccess('OPERATIONS')
  @Get()
  @Header('Cache-Control', 'private, no-store')
  async status(@Req() request: PlatformRequest) {
    if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
    await this.platform.requirePermission(request.platformPrincipal, 'OPERATIONS', { action: 'READ_STORAGE_OPERATIONS', targetType: 'STORAGE' });
    const config = storageConfiguration();
    let maintenance;
    try { maintenance = { status: 'CONFIGURED_NOT_RUNTIME_VERIFIED', ...documentMaintenanceConfiguration() }; }
    catch { maintenance = { status: 'BLOCKED_INVALID_MAINTENANCE_CONFIGURATION' }; }
    const objects = createS3ArtifactStoreFromEnv();
    let storage: { status: string; failure?: string } = { status: 'NOT_CONFIGURED' };
    try { if (objects) storage = await objects.probe(); }
    finally { objects?.close(); }
    // Same READ ONLY snapshot for queue/retention facts, with bounded SQL execution.
    const jobs = await this.store.db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      const summary = await tx.execute(sql`
        SELECT json_build_object(
          'ingestPending', (SELECT count(*) FROM document_ingest_jobs WHERE state = 'PENDING'),
          'ingestProcessing', (SELECT count(*) FROM document_ingest_jobs WHERE state = 'PROCESSING'),
          'ingestRecoveryCandidates', (SELECT count(*) FROM document_ingest_jobs WHERE state = 'PROCESSING' AND (lease_expires_at < now() OR lease_expires_at IS NULL)),
          'ingestFailed', (SELECT count(*) FROM document_ingest_jobs WHERE state = 'FAILED'),
          'expiredAwaitingRevocation', (SELECT count(*) FROM documents WHERE deleted_at IS NULL AND expires_at <= now()),
          'deletionPending', (SELECT count(*) FROM document_storage_deletions WHERE state = 'PENDING'),
          'deletionDue', (SELECT count(*) FROM document_storage_deletions WHERE state = 'PENDING' AND not_before <= now() AND (lease_expires_at IS NULL OR lease_expires_at < now())),
          'deletionFailed', (SELECT count(*) FROM document_storage_deletions WHERE state = 'FAILED')
        ) AS counts`);
      const failures = await tx.execute(sql`
        SELECT 'INGEST' AS kind, id, workspace_id, document_id, attempts, left(last_error_code, 100) AS error_code, updated_at
        FROM document_ingest_jobs WHERE state = 'FAILED'
        UNION ALL
        SELECT 'DELETION' AS kind, id, workspace_id, document_id, attempts, left(last_error_code, 100) AS error_code, updated_at
        FROM document_storage_deletions WHERE state = 'FAILED'
        ORDER BY updated_at DESC LIMIT 25`);
      return { summary: summary.rows, failures: failures.rows };
    });
    return { checkedAt: new Date().toISOString(), storage, configurationIssues: config.issues, maintenance, jobs,
      boundary: 'Read/list availability only; not PUT, encryption, physical version erasure or P22 certification. FAILED jobs require operator review, never automatic reset.' };
  }
}
