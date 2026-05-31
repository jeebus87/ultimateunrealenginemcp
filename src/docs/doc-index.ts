// src/docs/doc-index.ts
// DocIndex — MiniSearch-backed search engine for the UE 5.7 API reference.
// Wraps MiniSearch with four query methods: search, lookupClass, getIncludePath, checkDeprecation.

import MiniSearch from 'minisearch';
import type { ApiRecord, SearchResult } from './types.js';

/**
 * DocIndex wraps MiniSearch to provide full-text search and exact lookups
 * over the curated UE 5.7 API record set.
 *
 * Usage:
 *   const index = new DocIndex();
 *   index.load(records);         // call once at startup
 *   index.search('StaticMesh');  // ranked full-text results
 */
export class DocIndex {
  private readonly miniSearch: MiniSearch<ApiRecord>;
  private readonly byId: Map<string, ApiRecord> = new Map();
  private readonly byClass: Map<string, ApiRecord[]> = new Map();

  constructor() {
    this.miniSearch = new MiniSearch<ApiRecord>({
      idField: 'id',
      fields: ['name', 'fullName', 'description', 'signature', 'parameters', 'className'],
      storeFields: [
        'id',
        'type',
        'name',
        'fullName',
        'className',
        'signature',
        'returnType',
        'parameters',
        'includePath',
        'module',
        'deprecated',
        'deprecatedMessage',
        'replacementAPI',
        'description',
      ],
    });
  }

  /**
   * Load ApiRecord array into the index. Call once at startup.
   * Builds both the MiniSearch full-text index and the O(1) lookup maps.
   */
  load(records: ApiRecord[]): void {
    if (records.length === 0) return;

    this.miniSearch.addAll(records);

    for (const record of records) {
      this.byId.set(record.id, record);

      const key = record.className.toLowerCase();
      const existing = this.byClass.get(key);
      if (existing !== undefined) {
        existing.push(record);
      } else {
        this.byClass.set(key, [record]);
      }
    }
  }

  /**
   * Full-text search across name, fullName, description, signature, parameters.
   * Returns results ranked by relevance (highest score first), up to `limit` (default 20).
   * Returns [] if the index is empty or no results match.
   */
  search(query: string, limit = 20): SearchResult[] {
    if (this.byId.size === 0) return [];

    const raw = this.miniSearch.search(query, { fuzzy: 0.2, prefix: true });

    return raw.slice(0, limit).map((result) => ({
      record: this.byId.get(result.id as string) as ApiRecord,
      score: result.score,
      terms: result.terms,
    }));
  }

  /**
   * Exact class lookup (case-insensitive on className field).
   * Returns ALL records belonging to that class (class record + its members).
   */
  lookupClass(className: string): ApiRecord[] {
    return this.byClass.get(className.toLowerCase()) ?? [];
  }

  /**
   * Returns the includePath for the first ApiRecord whose className matches (case-insensitive).
   * Returns null if no match found.
   */
  getIncludePath(className: string): string | null {
    const records = this.lookupClass(className);
    if (records.length === 0) return null;
    return records[0]!.includePath;
  }

  /**
   * Returns deprecation status for a symbol matched by name or fullName (case-insensitive).
   * Returns null if no record matched at all.
   */
  checkDeprecation(
    symbolName: string
  ): { deprecated: boolean; message: string; replacement: string } | null {
    const lower = symbolName.toLowerCase();

    for (const record of this.byId.values()) {
      if (
        record.name.toLowerCase() === lower ||
        record.fullName.toLowerCase() === lower
      ) {
        return {
          deprecated: record.deprecated,
          message: record.deprecatedMessage,
          replacement: record.replacementAPI,
        };
      }
    }

    return null;
  }
}
