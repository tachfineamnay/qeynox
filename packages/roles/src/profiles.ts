import { and, eq, desc } from 'drizzle-orm';
import { DomainError, type ID } from '@qeynox/domain';
import { agentProfiles, type QeyNoxDatabase } from '@qeynox/persistence';
import type { AgentProfile } from '@qeynox/engine';

export class AgentProfileStore {
  constructor(private readonly db:QeyNoxDatabase) {}
  async getActive(roleKey:string):Promise<AgentProfile> {
    const [r]=await this.db.select().from(agentProfiles).where(and(eq(agentProfiles.roleKey,roleKey),eq(agentProfiles.active,true))).orderBy(desc(agentProfiles.version)).limit(1);
    if (!r)throw new DomainError('NOT_CONFIGURED','No active agent profile for '+roleKey);
    const profile=r.payload as unknown as AgentProfile;
    if (!profile || profile.id!==r.id || profile.version!==r.version || !profile.systemInstructions || profile.maxIterations<1) throw new DomainError('INVALID_STATE','Agent profile has invalid versioned contract');
    return profile;
  }
}
