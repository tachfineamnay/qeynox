import { diagnostics } from './contract.mjs';
const role = process.argv[2];
const issues = diagnostics(role, process.env);
console.log(JSON.stringify({ role, status: issues.length ? 'BLOCKED' : 'CONFIGURED_NOT_VERIFIED', issues }));
process.exitCode = issues.length ? 1 : 0;
