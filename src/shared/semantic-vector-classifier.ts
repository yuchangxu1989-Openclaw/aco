import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 8000;

function resolveSemanticVectorDbPath(): string {
  if (process.env.ACO_SEMANTIC_VECTOR_DB_PATH) return process.env.ACO_SEMANTIC_VECTOR_DB_PATH;
  const moduleDir = currentModuleDir();
  const candidates = [
    moduleDir ? resolve(moduleDir, '..', 'data', 'semantic-vectors.json') : '',
    moduleDir ? resolve(moduleDir, '..', '..', '..', 'src', 'data', 'semantic-vectors.json') : '',
    resolve(process.cwd(), 'src', 'data', 'semantic-vectors.json'),
    resolve(process.cwd(), 'projects', 'aco', 'src', 'data', 'semantic-vectors.json'),
    resolve(process.cwd(), 'data', 'semantic-vectors.json'),
    resolve(process.cwd(), '..', 'src', 'data', 'semantic-vectors.json'),
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

function currentModuleDir(): string | null {
  const stack = new Error().stack ?? '';
  const match = stack.match(/(?:file:\/\/)?(\/[^\s()]+semantic-vector-classifier\.(?:js|ts))/);
  if (!match) return null;
  const filePath = match[0].startsWith('file://') ? fileURLToPath(match[0]) : match[1];
  return dirname(filePath);
}

export const SEMANTIC_VECTOR_DB_PATH = resolveSemanticVectorDbPath();
export const SEMANTIC_VECTOR_DB_VERSION = 1;
export const SEMANTIC_VECTOR_MODEL = 'doubao-embedding-vision-251215';
export const SEMANTIC_VECTOR_DIMENSIONS = 2048;
export const SEMANTIC_VECTOR_DIRECT_THRESHOLD = 0.45;
export const SEMANTIC_VECTOR_FALLBACK_THRESHOLD = 0.35;

export interface EmbeddingConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SemanticVectorSample<TLabel extends string = string> {
  id: string;
  domain: string;
  label: TLabel;
  text: string;
  vector: number[];
}

export interface SemanticVectorDb<TLabel extends string = string> {
  version: number;
  providerId: string;
  model: string;
  dimensions: number;
  thresholds: {
    direct: number;
    fallback: number;
  };
  samples: Array<SemanticVectorSample<TLabel>>;
}

export type SemanticMatchBand = 'direct' | 'fallback' | 'none';

export interface SemanticVectorMatch<TLabel extends string = string> {
  ok: boolean;
  label: TLabel | null;
  score: number;
  confidenceBand: SemanticMatchBand;
  matchedSampleId: string | null;
  matchedSampleText: string | null;
  providerId: string;
  model: string;
  reason?: string;
}

let dbCache: { mtimeMs: number; db: SemanticVectorDb } | null = null;
const embeddingCache = new Map<string, number[]>();

export function readEmbeddingConfig(): EmbeddingConfig | null {
  try {
    const providerId = 'volcengine-ark';
    const cfgPath = resolve(process.env.HOME ?? '/root', '.openclaw', 'openclaw.json');
    if (!existsSync(cfgPath)) return null;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    const providers = (cfg.models as Record<string, unknown> | undefined)?.providers as Record<string, unknown> | undefined;
    const provider = providers?.[providerId] as Record<string, unknown> | undefined;
    const baseUrl = String(provider?.baseUrl ?? provider?.baseURL ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
    const apiKey = String(process.env.ARK_API_KEY ?? provider?.apiKey ?? '');
    if (!apiKey) return null;
    return { providerId, baseUrl, apiKey, model: SEMANTIC_VECTOR_MODEL };
  } catch {
    return null;
  }
}

export async function embedText(text: string, config: EmbeddingConfig | null = null, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number[] | null> {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const embeddingConfig = config ?? readEmbeddingConfig();
  if (!embeddingConfig) return null;

  const cacheKey = `${embeddingConfig.providerId}:${embeddingConfig.model}:${normalized}`;
  const cached = embeddingCache.get(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${embeddingConfig.baseUrl}/embeddings/multimodal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${embeddingConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: embeddingConfig.model,
        input: [{ type: 'text', text: normalized.slice(0, 4000) }],
        encoding_format: 'float',
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = await response.json() as { data?: { embedding?: unknown } | Array<{ embedding?: unknown }> };
    const raw = Array.isArray(payload.data) ? payload.data[0]?.embedding : payload.data?.embedding;
    if (!Array.isArray(raw) || raw.length !== SEMANTIC_VECTOR_DIMENSIONS) return null;
    const vector = raw.map(Number);
    if (vector.some(value => !Number.isFinite(value))) return null;
    embeddingCache.set(cacheKey, vector);
    return vector;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function loadSemanticVectorDb({ path = SEMANTIC_VECTOR_DB_PATH, refresh = false } = {}): SemanticVectorDb {
  if (!existsSync(path)) throw new Error(`semantic vector database not found: ${path}`);
  const mtimeMs = statSync(path).mtimeMs;
  if (!refresh && dbCache && dbCache.mtimeMs === mtimeMs) return dbCache.db;

  const raw = JSON.parse(readFileSync(path, 'utf8')) as SemanticVectorDb;
  if (raw.version !== SEMANTIC_VECTOR_DB_VERSION) throw new Error(`unsupported semantic vector db version: ${raw.version}`);
  if (raw.model !== SEMANTIC_VECTOR_MODEL) throw new Error(`unexpected semantic vector model: ${raw.model}`);
  if (raw.dimensions !== SEMANTIC_VECTOR_DIMENSIONS) throw new Error(`unexpected semantic vector dimensions: ${raw.dimensions}`);
  if (!Array.isArray(raw.samples)) throw new Error('semantic vector db samples must be an array');
  for (const sample of raw.samples) {
    if (!sample || typeof sample.domain !== 'string' || typeof sample.label !== 'string' || !Array.isArray(sample.vector)) {
      throw new Error('invalid semantic vector sample shape');
    }
    if (sample.vector.length !== SEMANTIC_VECTOR_DIMENSIONS) throw new Error(`invalid semantic vector dimensions for sample ${sample.id}`);
  }

  dbCache = { mtimeMs, db: raw };
  return raw;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function matchSemanticVector<TLabel extends string = string>({
  text,
  domain,
  path = SEMANTIC_VECTOR_DB_PATH,
  vector,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  text: string;
  domain: string;
  path?: string;
  vector?: number[] | null;
  timeoutMs?: number;
}): Promise<SemanticVectorMatch<TLabel>> {
  const db = loadSemanticVectorDb({ path }) as SemanticVectorDb<TLabel>;
  const samples = db.samples.filter(sample => sample.domain === domain);
  if (samples.length === 0) {
    return unavailable(db, 'no samples for domain');
  }

  const queryVector = vector ?? await embedText(text, null, timeoutMs);
  if (!queryVector || queryVector.length !== db.dimensions) {
    return unavailable(db, 'query embedding unavailable');
  }

  let best: { sample: SemanticVectorSample<TLabel>; score: number } | null = null;
  for (const sample of samples) {
    const score = cosineSimilarity(queryVector, sample.vector);
    if (!best || score > best.score) best = { sample, score };
  }

  if (!best) return unavailable(db, 'no comparable vectors');

  const band: SemanticMatchBand = best.score >= db.thresholds.direct
    ? 'direct'
    : best.score >= db.thresholds.fallback
      ? 'fallback'
      : 'none';

  return {
    ok: band !== 'none',
    label: band === 'none' ? null : best.sample.label,
    score: best.score,
    confidenceBand: band,
    matchedSampleId: best.sample.id,
    matchedSampleText: best.sample.text,
    providerId: db.providerId,
    model: db.model,
  };
}

function unavailable<TLabel extends string>(db: SemanticVectorDb<TLabel>, reason: string): SemanticVectorMatch<TLabel> {
  return {
    ok: false,
    label: null,
    score: -1,
    confidenceBand: 'none',
    matchedSampleId: null,
    matchedSampleText: null,
    providerId: db.providerId,
    model: db.model,
    reason,
  };
}
