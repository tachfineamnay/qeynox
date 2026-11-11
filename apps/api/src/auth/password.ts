import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const PARAMETERS = {N:32768,r:8,p:1,maxmem:64*1024*1024} as const;
export async function hashPassword(password:string,salt?:string):Promise<{salt:string;hash:string}> {
  if(password.length<12 || password.length>256)throw new Error('Invalid password length');
  const s=salt??randomBytes(24).toString('hex');
  const result=await scrypt(password,s,64,PARAMETERS) as Buffer;
  return {salt:s,hash:result.toString('hex')};
}
export async function verifyPassword(password:string,salt:string,expected:string):Promise<boolean> {
  if(typeof password!=='string'||password.length>256||password.length<1)return false;
  const actual=await scrypt(password,salt,64,PARAMETERS) as Buffer;
  const given=Buffer.from(expected,'hex');
  return actual.length===given.length&&timingSafeEqual(actual,given);
}
export const hashSessionToken=(value:string)=>createHash('sha256').update(value).digest('hex');
