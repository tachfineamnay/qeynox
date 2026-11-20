/**
 * MISSION A17 — optional embeddings for the document vault (reviewed RAG infrastructure).
 *
 * Embeddings are OPTIONAL and are never required for retrieval: without configuration the vault
 * answers with PostgreSQL full-text search and reports embedding:NOT_CONFIGURED. When configured,
 * the provider must be an OpenAI-compatible embeddings endpoint reached exclusively through the
 * attested, host-allowlisted secure egress client — the same posture as every reviewed provider.
 * The API key lives only in server-side configuration and never appears in logs, rows or prompts.
 *
 * Nothing here fabricates a vector: distances are computed from provider-returned float arrays,
 * rounded to 6 decimals and stored as JSON. There is no pgvector dependency; ranking happens in
 * application code over the tenant-scoped candidate pool (≤ 20 rows per query).
 */
import { DomainError } from '@qeynox/domain';
import { EgressPolicy, secureProviderRequest } from '@qeynox/tools';

export interface EmbeddingProvider {
  readonly id: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface OpenAiCompatibleEmbeddingOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly allowedHosts: readonly string[];
  readonly egress: InstanceType<typeof EgressPolicy>;
  readonly timeoutMs?: number;
  readonly maxInputChars?: number;
}

/** Minimal, strict client for POST {endpoint} { model, input: [text] } → { data: [{ embedding }] }. */
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai-compatible';
  constructor(private readonly options: OpenAiCompatibleEmbeddingOptions) {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (!texts.length) return [];
    if (texts.length > 32) throw new DomainError('INVALID_INPUT', 'Too many inputs for one embedding request');
    const maxChars = this.options.maxInputChars ?? 8000;
    for (const text of texts) {
      if (text.length > maxChars) throw new DomainError('INVALID_INPUT', 'Embedding input exceeds the configured limit');
    }
    let url: URL;
    try { url = new URL(this.options.endpoint); } catch { throw new DomainError('NOT_CONFIGURED', 'Embeddings endpoint is not a valid URL'); }
    if (url.protocol !== 'https:') {
      // Loopback http is tolerated ONLY for explicit QA via the injected provider seam; never here.
      throw new DomainError('NOT_CONFIGURED', 'Embeddings endpoint must be https');
    }
    if (!this.options.allowedHosts.includes(url.hostname)) {
      throw new DomainError('NOT_CONFIGURED', 'Embeddings host is not allowlisted: ' + url.hostname);
    }
    this.options.egress.assertAllowed(url);
    const response = await secureProviderRequest(url, this.options.egress, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.options.apiKey },
      body: JSON.stringify({ model: this.options.model, input: [...texts] }),
      maxBytes: 4_000_000,
      timeoutMs: this.options.timeoutMs ?? 30000,
    });
    if (response.status === 401 || response.status === 403) {
      throw new DomainError('NOT_CONFIGURED', 'Embeddings provider rejected the configured credential');
    }
    if (response.status === 429) throw new DomainError('BUDGET_EXHAUSTED', 'Embeddings provider rate limit or quota exceeded');
    if (response.status >= 500) throw new DomainError('UNAVAILABLE', 'Embeddings provider responded HTTP ' + response.status);
    if (response.status < 200 || response.status >= 300) throw new DomainError('INVALID_STATE', 'Embeddings provider responded HTTP ' + response.status);
    let json: unknown;
    try { json = JSON.parse(response.body); } catch { throw new DomainError('INVALID_STATE', 'Embeddings provider returned malformed JSON'); }
    const data = (json as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new DomainError('INVALID_STATE', 'Embeddings provider returned an unexpected payload shape');
    }
    return data.map(entry => {
      const vector = (entry as { embedding?: unknown }).embedding;
      if (!Array.isArray(vector) || vector.length === 0 || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new DomainError('INVALID_STATE', 'Embeddings provider returned an invalid vector');
      }
      return vector.map(value => Number(value.toFixed(6)));
    });
  }
}

/**
 * Deployment wiring. Returns undefined unless ALL of the following hold: switch on, https endpoint,
 * API key, model, at least one allowlisted host, attested egress policy. Anything less ⇒ the
 * document vault runs in FTS-only mode and says so.
 */
export function embeddingsFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | undefined {
  if ((env.QEYNOX_EMBEDDINGS_ENABLED ?? '') !== 'true') return undefined;
  const endpoint = (env.QEYNOX_EMBEDDINGS_ENDPOINT ?? '').trim();
  const apiKey = (env.QEYNOX_EMBEDDINGS_API_KEY ?? '').trim();
  const model = (env.QEYNOX_EMBEDDINGS_MODEL ?? '').trim();
  const allowedHosts = (env.QEYNOX_EMBEDDINGS_ALLOWED_HOSTS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (!endpoint || !apiKey || !model || !allowedHosts.length) return undefined;
  // Attested egress is a hard gate, same as every reviewed provider.
  if ((env.QEYNOX_NETWORK_POLICY_ATTESTED ?? '') !== 'true') return undefined;
  const egress = new EgressPolicy({ attested: true, allowedHosts });
  return new OpenAiCompatibleEmbeddingProvider({ endpoint, apiKey, model, allowedHosts, egress });
}

/** cosine similarity; both vectors must be non-empty and of equal non-zero length. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
