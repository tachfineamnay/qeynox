// Offline desired config only. JSON is valid YAML. Never reads/mints credentials or calls a model.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function renderHermesVertex(env) {
  const project = env.QEYNOX_HERMES_VERTEX_PROJECT;
  const region = env.QEYNOX_HERMES_VERTEX_REGION;
  const model = env.QEYNOX_HERMES_VERTEX_MODEL;
  const issues = [];
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project ?? '')) issues.push('QEYNOX_HERMES_VERTEX_PROJECT');
  if (!/^(global|[a-z]+-[a-z]+[0-9])$/.test(region ?? '')) issues.push('QEYNOX_HERMES_VERTEX_REGION');
  if (!/^google\/gemini-[a-z0-9][a-z0-9.-]{0,119}$/.test(model ?? '')) issues.push('QEYNOX_HERMES_VERTEX_MODEL');
  if (/^google\/gemini-3/.test(model ?? '') && region !== 'global') issues.push('QEYNOX_HERMES_VERTEX_REGION (Gemini 3 requires global)');
  if (issues.length) throw new Error('HERMES_VERTEX_CONFIG_BLOCKED: ' + issues.join(', '));
  const config = JSON.parse(readFileSync(new URL('./hermes-config.yaml', import.meta.url), 'utf8'));
  config.model = { provider: 'vertex', default: model };
  config.vertex = { project_id: project, region };
  config.platforms.api_server.extra.model_routes = { [model]: { provider: 'vertex', model } };
  // Listing the route makes HERMES_MODEL discoverable; a generic hermes-agent alias is NOT model proof.
  return config;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(renderHermesVertex(process.env), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'HERMES_VERTEX_CONFIG_BLOCKED'); process.exitCode = 1; }
}
