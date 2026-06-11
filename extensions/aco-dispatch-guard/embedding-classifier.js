/**
 * Shared embedding-based classifier for ACO extensions.
 *
 * Provides embedText + cosineSimilarity + classifyByEmbedding.
 * Embedding provider: volcengine-ark doubao-embedding-vision-251215.
 * Fallback: embedding failure → returns null so callers can fail-open.
 */

import fs from 'fs';
import path from 'path';

const EMBEDDING_TIMEOUT_MS = 8000;
const embeddingCache = new Map();

const SEVO_DATA_DIR = path.resolve(
  process.env.OPENCLAW_HOME || path.join(process.env.HOME || '/root', '.openclaw'),
  'workspace', 'projects', 'sevo', 'data',
);

export function readEmbeddingConfig() {
  if (process.env.ARK_API_KEY) {
    return {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: process.env.ARK_API_KEY,
      model: 'doubao-embedding-vision-251215',
    };
  }
  try {
    const cfgPath = path.resolve(
      process.env.OPENCLAW_HOME || path.join(process.env.HOME || '/root', '.openclaw'),
      'openclaw.json',
    );
    if (!fs.existsSync(cfgPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const memSearch = cfg?.agents?.defaults?.memorySearch;
    if (memSearch?.remote?.baseUrl) {
      return {
        baseUrl: memSearch.remote.baseUrl.replace(/\/+$/, ''),
        apiKey: memSearch.remote.apiKey || 'local',
        model: memSearch.model || 'doubao-embedding-vision-251215',
      };
    }
    const provider = cfg?.models?.providers?.['volcengine-ark'];
    if (!provider?.apiKey || !provider?.baseUrl) return null;
    const models = Array.isArray(provider.models) ? provider.models : [];
    const embModel = models.find(m => m?.id?.includes('embedding'));
    return {
      baseUrl: provider.baseUrl.replace(/\/+$/, ''),
      apiKey: provider.apiKey,
      model: embModel?.id || 'doubao-embedding-vision-251215',
    };
  } catch {
    return null;
  }
}
export async function embedText(text, config = null) {
  const normalized = String(text || '').trim();
  if (!normalized) return null;
  const embeddingConfig = config || readEmbeddingConfig();
  if (!embeddingConfig) return null;

  const cacheKey = `${embeddingConfig.model}:${normalized.slice(0, 200)}`;
  if (embeddingCache.has(cacheKey)) return embeddingCache.get(cacheKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  try {
    const url = `${embeddingConfig.baseUrl}/embeddings`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${embeddingConfig.apiKey}`,
      },
      body: JSON.stringify({ model: embeddingConfig.model, input: [normalized.slice(0, 4000)] }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) return null;
    embeddingCache.set(cacheKey, vector);
    return vector;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return -1;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function loadVectorDb(dbName) {
  const dbPath = path.join(SEVO_DATA_DIR, dbName);
  try {
    if (!fs.existsSync(dbPath)) return null;
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const samples = (Array.isArray(raw.samples) ? raw.samples : [])
      .filter(s => s?.id && s?.label && Array.isArray(s?.vector) && s.vector.length > 0);
    return {
      thresholds: { direct: raw.thresholds?.direct ?? 0.50, fallback: raw.thresholds?.fallback ?? 0.38 },
      samples,
    };
  } catch {
    return null;
  }
}

export async function classifyByEmbedding(text, dbName, options = {}) {
  const noMatch = { matched: false, label: null, score: 0, confidence: 'none' };

  const db = loadVectorDb(dbName);
  if (!db || db.samples.length === 0) return noMatch;

  const config = options.config || readEmbeddingConfig();
  const queryVector = await embedText(text, config);
  if (!queryVector) return noMatch;

  const candidates = options.labelFilter
    ? db.samples.filter(s => s.label === options.labelFilter)
    : db.samples;

  if (candidates.length === 0) return noMatch;

  let bestScore = -1;
  let bestSample = null;

  for (const sample of candidates) {
    if (sample.vector.length !== queryVector.length) continue;
    const score = cosineSimilarity(queryVector, sample.vector);
    if (score > bestScore) {
      bestScore = score;
      bestSample = sample;
    }
  }

  if (!bestSample) return noMatch;

  const confidence = bestScore >= db.thresholds.direct ? 'direct'
    : bestScore >= db.thresholds.fallback ? 'fallback' : 'none';

  return {
    matched: confidence !== 'none',
    label: bestSample.label,
    score: bestScore,
    confidence,
    sampleId: bestSample.id,
  };
}
