/**
 * Long-term memory system
 *
 * Based on:
 * - src/memory/manager.ts — MemoryIndexManager (index + search orchestration)
 * - src/memory/manager-search.ts — searchVector() / searchKeyword() implementation
 * - src/memory/memory-schema.ts — SQLite schema (chunks / chunks_fts / chunks_vec)
 * - src/memory/hybrid.ts — mergeHybridResults() hybrid scoring
 * - src/memory/internal.ts — chunkMarkdown() chunking
 *
 * Full architecture:
 * - Storage: SQLite (chunks table + FTS5 full-text index + sqlite-vec vector index)
 * - Search: BM25 keyword search + cosine similarity vector search → weighted hybrid
 * - Chunking: Markdown line-based chunking (token limit + overlap)
 * - Sources: "memory" (MEMORY.md / memory/*.md) and "sessions" (session records)
 * - No time decay: ranking is purely based on semantic/keyword relevance
 *
 * Gen Agent simplification:
 * - Storage: File-system JSON index (instead of SQLite)
 * - Search: BM25-style term frequency scoring (instead of FTS5 + vector search)
 * - Chunking: Whole-entry storage (skip chunkMarkdown chunking strategy)
 * - Sources: Only "memory" (skip sessions indexing)
 *
 * Retained core design:
 * - Pure relevance ranking (no time decay)
 * - source identifier
 * - hash-based deduplication
 * - search + save dual API
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ============== Types ==============

/**
 * Memory source
 *
 * Based on: MemorySource
 * - memory: from MEMORY.md or memory/*.md files
 * - sessions: from session records (not implemented in gen-agent)
 */
export type MemorySource = "memory" | "sessions";

/**
 * Memory entry
 *
 * Simplified version of the chunks table:
 * - id: unique identifier (generated from content hash, used for deduplication)
 * - content: raw text content
 * - source: data source identifier
 * - path: source file path
 * - hash: content hash (used for change detection)
 * - createdAt: creation timestamp (metadata only, not used in search ranking)
 */
export interface MemoryEntry {
  id: string;
  content: string;
  source: MemorySource;
  path?: string;
  hash: string;
  createdAt: number;
}

/**
 * Search result
 *
 * Based on: MemorySearchResult
 * score is purely based on keyword relevance (no time decay)
 */
export interface MemorySearchResult {
  entry: MemoryEntry;
  /** Relevance score (pure keyword/semantic match, no time factor) */
  score: number;
  /** Content snippet (for preview) */
  snippet: string;
}

// ============== Search algorithm ==============

/**
 * BM25-style keyword scoring
 *
 * Based on: FTS5 BM25 + bm25RankToScore()
 *
 * A true BM25 requires an inverted index and IDF statistics; this is a simplified version:
 * - Term frequency (TF): number of occurrences of a term in the document
 * - Document length normalization: matches in shorter documents are weighted higher
 * - Query coverage: proportion of matched query terms
 *
 * Key: no time decay, aligned with the original design decision
 */
function computeKeywordScore(
  content: string,
  queryTerms: string[],
): number {
  if (queryTerms.length === 0) return 0;

  const text = content.toLowerCase();
  const docLength = text.length;
  // Avoid division by zero; give extremely short documents a minimum length
  const normalizedLength = Math.max(docLength, 1);

  let matchedTerms = 0;
  let totalTf = 0;

  for (const term of queryTerms) {
    // Count term frequency
    let tf = 0;
    let pos = 0;
    while (true) {
      const idx = text.indexOf(term, pos);
      if (idx === -1) break;
      tf += 1;
      pos = idx + term.length;
    }

    if (tf > 0) {
      matchedTerms += 1;
      // BM25-style saturation: tf / (tf + k1), prevents high-frequency terms from over-scoring
      const k1 = 1.2;
      const saturatedTf = tf / (tf + k1);
      totalTf += saturatedTf;
    }
  }

  if (matchedTerms === 0) return 0;

  // Query coverage: how many query terms were matched
  const coverage = matchedTerms / queryTerms.length;

  // Document length penalty: matches in shorter documents are more valuable
  const avgDocLength = 500; // Assumed average document length
  const b = 0.75; // BM25 b parameter
  const lengthPenalty = 1 - b + b * (normalizedLength / avgDocLength);

  // Final score: coverage * term frequency / length penalty
  return (coverage * totalTf) / lengthPenalty;
}

/**
 * Extract query terms
 *
 * Based on: buildFtsQuery() in manager-search.ts
 * Extracts alphanumeric tokens (aligned with the FTS5 tokenizer)
 */
function extractQueryTerms(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/g) ?? [];
  // Deduplicate
  return [...new Set(tokens)];
}

// ============== MemoryManager ==============

export class MemoryManager {
  private baseDir: string;
  private entries: MemoryEntry[] = [];
  private loaded = false;

  constructor(baseDir: string = "./.gen-agent/memory") {
    this.baseDir = baseDir;
  }

  private get indexPath(): string {
    return path.join(this.baseDir, "index.json");
  }

  /**
   * Load memory index
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const content = await fs.readFile(this.indexPath, "utf-8");
      this.entries = JSON.parse(content);
    } catch {
      this.entries = [];
    }
    this.loaded = true;
  }

  /**
   * Save memory index
   */
  private async save(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(this.entries, null, 2));
  }

  /**
   * Compute content hash
   *
   * Based on: hashText() used for deduplication and change detection
   */
  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  /**
   * Add memory
   *
   * Simplified version of indexFile():
   * - Uses content hash to generate ID (deduplication)
   * - Existing entries with the same hash are updated rather than duplicated
   */
  async add(
    content: string,
    source: MemorySource = "memory",
    filePath?: string,
  ): Promise<string> {
    await this.load();

    const hash = this.hashContent(content);
    const id = `mem_${hash}`;

    // Hash deduplication: same content → update
    const existingIndex = this.entries.findIndex((e) => e.hash === hash);
    if (existingIndex >= 0) {
      this.entries[existingIndex].content = content;
      this.entries[existingIndex].path = filePath;
      await this.save();
      return this.entries[existingIndex].id;
    }

    const entry: MemoryEntry = {
      id,
      content,
      source,
      path: filePath,
      hash,
      createdAt: Date.now(),
    };
    this.entries.push(entry);
    await this.save();
    return id;
  }

  /**
   * Search memory
   *
   * Based on: manager.search() → searchKeyword() + mergeHybridResults()
   *
   * Core design:
   * - Pure keyword relevance ranking
   * - No time decay (explicit design decision)
   * - Results sorted by score descending, truncated to limit
   */
  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    await this.load();

    const queryTerms = extractQueryTerms(query);
    if (queryTerms.length === 0) return [];

    const scored: MemorySearchResult[] = [];

    for (const entry of this.entries) {
      const score = computeKeywordScore(entry.content, queryTerms);

      if (score > 0) {
        const snippet = entry.content.slice(0, 200);
        scored.push({ entry, score, snippet });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Get memory by ID
   */
  async getById(id: string): Promise<MemoryEntry | null> {
    await this.load();
    return this.entries.find((e) => e.id === id) ?? null;
  }

  /**
   * Scan .md files in the memory directory
   *
   * Batch version of indexFile().
   * Uses hash to detect changes; only updates entries whose content has changed.
   */
  async syncFromFiles(): Promise<number> {
    await this.load();
    const memDir = path.join(this.baseDir, "files");

    try {
      const files = await fs.readdir(memDir);
      let synced = 0;

      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(memDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        const hash = this.hashContent(content);

        // Hash-based change detection
        const existing = this.entries.find((e) => e.path === filePath);
        if (existing && existing.hash === hash) continue;

        await this.add(content, "memory", filePath);
        synced++;
      }

      return synced;
    } catch {
      return 0;
    }
  }

  /**
   * Get all memories (for debugging)
   */
  async getAll(): Promise<MemoryEntry[]> {
    await this.load();
    return this.entries;
  }

  /**
   * Clear memory
   */
  async clear(): Promise<void> {
    this.entries = [];
    await this.save();
  }
}
