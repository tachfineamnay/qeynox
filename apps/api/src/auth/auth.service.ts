import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Inject } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseConnection } from '@qeynox/persistence';
import { identityUsers, identityCredentials, identityWorkspaces, identityMemberships, identitySessions, identityAudit } from '@qeynox/persistence';
import { DomainError, type Principal, type ID } from '@qeynox/domain';
import { DB_CONNECTION } from '../database/database.module';
import { hashPassword, hashSessionToken, verifyPassword } from './password';

const signupSchema=z.object({email:z.email(),password:z.string().min(12).max(256),workspaceName:z.string().trim().min(2).max(120),locale:z.string().min(2).max(12).default('en')});
const loginSchema=z.object({email:z.email(),password:z.string().min(1).max(256)});
export type IdentitySession = {userId:ID;token:string;expiresAt:string;workspaceId:ID};
export type WorkspaceSummary = {workspaceId:ID;name:string;role:string};
const sessionTTL=24*60*60*1000;

@Injectable()
export class AuthService {
  constructor(@Inject(DB_CONNECTION)private readonly connection:DatabaseConnection){}
  private get db() {return this.connection.db;}
  async register(body:unknown):Promise<IdentitySession> {
    if(process.env.QEYNOX_ALLOW_REGISTRATION!=='true') throw new DomainError('NOT_CONFIGURED','Registration is disabled');
    const input=signupSchema.parse(body); const email=input.email.toLowerCase().trim();
    const id=randomUUID() as ID,workspaceId=randomUUID() as ID;
    const pw=await hashPassword(input.password);
    try {
      await this.db.transaction(async tx=>{
        await tx.insert(identityUsers).values({id,email,locale:input.locale});
        await tx.insert(identityCredentials).values({userId:id,salt:pw.salt,passwordHash:pw.hash});
        await tx.insert(identityWorkspaces).values({id:workspaceId,name:input.workspaceName,createdBy:id});
        await tx.insert(identityMemberships).values({id:randomUUID(),userId:id,workspaceId,role:'OWNER',status:'ACTIVE'});
        await tx.insert(identityAudit).values({id:randomUUID(),userId:id,workspaceId,action:'REGISTER',outcome:'SUCCESS'});
      });
    }catch(error:unknown){throw new DomainError('CONFLICT','Account could not be created');}
    return this.issueSession(id,workspaceId);
  }
  async login(body:unknown):Promise<IdentitySession> {
    const {email,password}=loginSchema.parse(body);
    const userId=await this.verifiedUserId(email,password);
    const [membership]=await this.db.select().from(identityMemberships).where(and(eq(identityMemberships.userId,userId),eq(identityMemberships.status,'ACTIVE'))).limit(1);
    if(!membership)throw new DomainError('DENIED','No active workspace membership');
    await this.db.insert(identityAudit).values({id:randomUUID(),userId,workspaceId:membership.workspaceId,action:'LOGIN',outcome:'SUCCESS'});
    return this.issueSession(userId,membership.workspaceId as ID);
  }
  /**
   * Verifies identity credentials only. Issues no workspace session and returns no workspace
   * authority; global platform administration reuses this existing scrypt/lockout path instead of
   * duplicating credential logic. Callers must never treat this result as a workspace principal.
   */
  async verifyCredentials(email:string,password:string):Promise<{userId:ID}> {
    const input=loginSchema.parse({email,password});
    return {userId:await this.verifiedUserId(input.email,input.password)};
  }
  private async verifiedUserId(email:string,password:string):Promise<ID> {
    const [row]=await this.db.select().from(identityUsers).where(eq(identityUsers.email,email.toLowerCase().trim())).limit(1);
    const [creds]=row?await this.db.select().from(identityCredentials).where(eq(identityCredentials.userId,row.id)).limit(1):[];
    if(!row||row.disabledAt||!creds||creds.lockedUntil&&creds.lockedUntil>new Date())throw new DomainError('DENIED','Invalid credentials');
    const ok=await verifyPassword(password,creds.salt,creds.passwordHash);
    if(!ok){
      const attempts=creds.failedAttempts+1;
      await this.db.update(identityCredentials).set({failedAttempts:attempts,lockedUntil:attempts>=6?new Date(Date.now()+15*60*1000):null}).where(eq(identityCredentials.userId,row.id));
      throw new DomainError('DENIED','Invalid credentials');
    }
    await this.db.update(identityCredentials).set({failedAttempts:0,lockedUntil:null}).where(eq(identityCredentials.userId,row.id));
    return row.id as ID;
  }
  async issueSession(userId:ID,workspaceId:ID):Promise<IdentitySession>{
    const [member]=await this.db.select().from(identityMemberships).where(and(eq(identityMemberships.userId,userId),eq(identityMemberships.workspaceId,workspaceId),eq(identityMemberships.status,'ACTIVE'))).limit(1);
    if(!member)throw new DomainError('DENIED','Inactive workspace membership');
    const token=randomBytes(48).toString('base64url');
    const expiresAt=new Date(Date.now()+sessionTTL);
    await this.db.insert(identitySessions).values({id:randomUUID(),userId,tokenHash:hashSessionToken(token),expiresAt});
    return {userId,workspaceId,token,expiresAt:expiresAt.toISOString()};
  }
  async verifyBearer(rawToken:string,requestedWorkspace?:string):Promise<Principal> {
    if(!rawToken||rawToken.length<32||rawToken.length>256)throw new DomainError('DENIED','Invalid session');
    const [session]=await this.db.select().from(identitySessions).where(and(eq(identitySessions.tokenHash,hashSessionToken(rawToken)),isNull(identitySessions.revokedAt),gt(identitySessions.expiresAt,new Date()))).limit(1);
    if(!session)throw new DomainError('DENIED','Session expired or revoked');
    const [user]=await this.db.select().from(identityUsers).where(eq(identityUsers.id,session.userId)).limit(1);
    if(!user||user.disabledAt)throw new DomainError('DENIED','Account disabled');
    const members=await this.db.select().from(identityMemberships).where(and(eq(identityMemberships.userId,session.userId),eq(identityMemberships.status,'ACTIVE')));
    const member=requestedWorkspace?members.find(m=>m.workspaceId===requestedWorkspace):members.length===1?members[0]:undefined;
    if(!member)throw new DomainError('DENIED','Select an authorized workspace');
    return {userId:session.userId as ID,workspaceId:member.workspaceId as ID,roles:[member.role]};
  }
  /** Active workspace memberships for the authenticated identity (switchable contexts). */
  async listWorkspaces(userId:ID):Promise<readonly WorkspaceSummary[]>{
    const rows=await this.db.select({workspaceId:identityWorkspaces.id,name:identityWorkspaces.name,role:identityMemberships.role})
      .from(identityMemberships)
      .innerJoin(identityWorkspaces,eq(identityWorkspaces.id,identityMemberships.workspaceId))
      .where(and(eq(identityMemberships.userId,userId),eq(identityMemberships.status,'ACTIVE')))
      .orderBy(identityWorkspaces.name);
    return rows.map(row=>({workspaceId:row.workspaceId as ID,name:row.name,role:row.role}));
  }
  /**
   * Explicit workspace switch for a member of several workspaces: validates the target membership,
   * revokes the presented session and issues a fresh one, so a token captured before the switch
   * cannot keep acting in the previous context.
   */
  async switchWorkspace(userId:ID,workspaceId:ID,rawToken:string):Promise<{session:IdentitySession;workspaces:readonly WorkspaceSummary[]}>{
    const [membership]=await this.db.select().from(identityMemberships)
      .where(and(eq(identityMemberships.userId,userId),eq(identityMemberships.workspaceId,workspaceId),eq(identityMemberships.status,'ACTIVE')))
      .limit(1);
    if(!membership)throw new DomainError('DENIED','No active membership in the requested workspace');
    await this.logout(rawToken);
    const session=await this.issueSession(userId,workspaceId);
    return {session,workspaces:await this.listWorkspaces(userId)};
  }
  async logout(token:string):Promise<void>{
    const hashed=hashSessionToken(token);
    await this.db.update(identitySessions).set({revokedAt:new Date()}).where(eq(identitySessions.tokenHash,hashed));
  }
  async rotate(token:string,workspaceId:string):Promise<IdentitySession>{
    const principal=await this.verifyBearer(token,workspaceId);
    await this.logout(token);
    return this.issueSession(principal.userId,principal.workspaceId);
  }
}
