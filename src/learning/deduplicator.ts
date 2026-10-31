import { chunksRepo } from '../db/repositories/chunks';
import { categoriesRepo } from '../db/repositories/categories';
import { filesRepo } from '../db/repositories/files';
import { codeExtractsRepo } from '../db/repositories/codeExtracts';
import { hashFact } from '../utils/hashing';
import { logger } from '../utils/logger';
import { getConfig } from '../config/config';
import { recordStat, generateRunId } from '../utils/stats';

export interface ExtractedFileInfo {
  name: string;
  purpose: string;
}

export interface ExtractedCodeExtract {
  fileName?: string;
  language?: string;
  symbols?: string[];
  code?: string;
}

export interface ExtractedLearning {
  fact: string;
  category: string;
  confidence: number;
  isNew: boolean;
  filesUsed?: ExtractedFileInfo[];
  codeExtracts?: ExtractedCodeExtract[];
}

export interface StoreResult {
  stored: number;
  skipped: number;
  updated: number;
}

/**
 * Deduplicates and stores extracted learnings for a project.
 * Returns counts of stored/skipped/updated facts.
 */
export async function deduplicateAndStore(
  learnings: ExtractedLearning[],
  projectId: string,
  sessionId?: string,
  requestId?: string
): Promise<StoreResult> {
  const config = getConfig();
  const result: StoreResult = { stored: 0, skipped: 0, updated: 0 };
  const filesReferenced = learnings.reduce((sum, learning) => sum + (learning.filesUsed?.length ?? 0), 0);
  const codeExtractsReferenced = learnings.reduce((sum, learning) => sum + (learning.codeExtracts?.length ?? 0), 0);

  for (const learning of learnings) {
    if (learning.confidence < config.context.minConfidence) {
      result.skipped++;
      continue;
    }

    if (!learning.isNew) {
      result.skipped++;
      continue;
    }

    const hash = hashFact(learning.fact);
    const existing = await chunksRepo.findByHash(projectId, hash);

    if (existing) {
      // Update confidence if higher
      if (learning.confidence > existing.confidence) {
        await chunksRepo.updateConfidence(existing.id, learning.confidence);
        result.updated++;
      } else {
        result.skipped++;
      }
      continue;
    }

    try {
      const chunk = await chunksRepo.insert({
        projectId,
        sessionId,
        requestId,
        fact: learning.fact,
        category: learning.category ?? 'general',
        confidence: learning.confidence,
        source: 'extraction',
        hash,
      });

      // Store associated files if provided
      if (learning.filesUsed && learning.filesUsed.length > 0) {
        await filesRepo.insertMany(
          learning.filesUsed.map((f) => ({
            chunkId: chunk.id,
            fileName: f.name,
            purpose: f.purpose,
          }))
        );
      }

      if (learning.codeExtracts && learning.codeExtracts.length > 0) {
        await codeExtractsRepo.insertMany(
          learning.codeExtracts.map((extract) => ({
            chunkId: chunk.id,
            fileName: extract.fileName,
            language: extract.language,
            symbols: extract.symbols,
            code: extract.code,
          }))
        );
      }

      // Assign to category if we can find it
      const cat = await categoriesRepo.findCategoryBySlug(projectId, learning.category);
      if (cat) {
        await categoriesRepo.assignToChunk(chunk.id, cat.id, learning.confidence);
      }

      result.stored++;
    } catch (err) {
      logger.error('Failed to store learning chunk', {
        error: String(err),
        fact: learning.fact.slice(0, 100),
      });
    }
  }

  if (result.stored > 0 || result.updated > 0) {
    logger.info('Learnings stored', { projectId, ...result });
  }

  // Record stats about what was extracted
  recordStat({
    projectId,
    model: 'inline', // inline learning doesn't use a specific model
    runId: requestId ?? generateRunId(),
    type: 'learning',
    direction: 'output',
    meta: {
      totalReceived: learnings.length,
      stored: result.stored,
      skipped: result.skipped,
      updated: result.updated,
      filesReferenced,
      codeExtractsReferenced,
      categories: [...new Set(learnings.map((l) => l.category))],
    },
    body: JSON.stringify(learnings),
  });

  return result;
}
