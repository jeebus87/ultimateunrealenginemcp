// tests/docs-tools.test.ts
// Integration tests for the four UE doc tool handlers.
//
// Strategy: Create a DocIndex loaded with the real UE57_API_RECORDS, then invoke
// the handler logic directly (same pragmatic approach as config-tools.test.ts).
// Handlers are exported as pure async functions from src/tools/docs/index.ts for
// testability — they accept args and use the module-level docIndex singleton.
//
// Import uses .js extensions — NodeNext ESM module resolution.

import { describe, it, expect, beforeAll } from 'vitest';
import { DocIndex } from '../src/docs/doc-index.js';
import { UE57_API_RECORDS } from '../src/docs/data/ue57-api.js';
import {
  handleSearchApi,
  handleLookupClass,
  handleGetIncludePath,
  handleCheckDeprecation,
} from '../src/tools/docs/index.js';

// ---------------------------------------------------------------------------
// Shared DocIndex loaded once for all tests
// ---------------------------------------------------------------------------

const docIndex = new DocIndex();

beforeAll(() => {
  docIndex.load(UE57_API_RECORDS);
});

// ---------------------------------------------------------------------------
// ue_search_api handler
// ---------------------------------------------------------------------------

describe('ue_search_api handler', () => {
  it('returns structured text with at least one result when query is "StaticMesh"', async () => {
    const result = await handleSearchApi({ query: 'StaticMesh' }, docIndex);
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]!.text).toBeTruthy();
    const text = result.content[0]!.text;
    expect(text).not.toBe('');
  });

  it('response text contains "UStaticMeshComponent" for query "StaticMesh"', async () => {
    const result = await handleSearchApi({ query: 'StaticMesh' }, docIndex);
    const text = result.content[0]!.text;
    expect(text).toContain('UStaticMeshComponent');
  });

  it('response text contains include path info for matched results', async () => {
    const result = await handleSearchApi({ query: 'StaticMesh' }, docIndex);
    const text = result.content[0]!.text;
    // Either the label "Include:" or the actual path "StaticMeshComponent.h"
    expect(text.toLowerCase()).toMatch(/include|staticmeshcomponent\.h/);
  });

  it('returns friendly "No results found" message (not isError) for nonexistent query', async () => {
    const result = await handleSearchApi({ query: 'xyzzy_nonexistent_9999' }, docIndex);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toMatch(/no results found/i);
  });

  it('returns at most 20 results by default (does not dump entire index)', async () => {
    // A broad 1-letter query that might match many things
    const result = await handleSearchApi({ query: 'component' }, docIndex);
    // The result text contains at most 20 numbered items
    const text = result.content[0]!.text;
    // Count numbered list items — each starts with "\n1.", "\n2.", etc.
    const matches = text.match(/^\s*\d+\./gm) ?? [];
    expect(matches.length).toBeLessThanOrEqual(20);
  });

  it('response text contains relevance scores or ranking info', async () => {
    const result = await handleSearchApi({ query: 'StaticMesh' }, docIndex);
    const text = result.content[0]!.text;
    expect(text).toMatch(/score/i);
  });
});

// ---------------------------------------------------------------------------
// ue_lookup_class handler
// ---------------------------------------------------------------------------

describe('ue_lookup_class handler', () => {
  it('returns isError with text containing "not found" for unknown class', async () => {
    const result = await handleLookupClass({ class_name: 'UNonExistentClass9999' }, docIndex);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not found/i);
  });

  it('returns response containing the includePath for "UStaticMeshComponent"', async () => {
    const result = await handleLookupClass({ class_name: 'UStaticMeshComponent' }, docIndex);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('StaticMeshComponent.h');
  });

  it('response contains the module name for "UStaticMeshComponent" (Engine)', async () => {
    const result = await handleLookupClass({ class_name: 'UStaticMeshComponent' }, docIndex);
    const text = result.content[0]!.text;
    expect(text).toContain('Engine');
  });

  it('response lists at least one member (function or property) of UStaticMeshComponent', async () => {
    const result = await handleLookupClass({ class_name: 'UStaticMeshComponent' }, docIndex);
    const text = result.content[0]!.text;
    // Members section header should be present
    expect(text).toMatch(/members/i);
    // At least one function entry
    expect(text).toMatch(/\[function\]/i);
  });

  it('lookup is case-insensitive: "ustaticmeshcomponent" returns same class as "UStaticMeshComponent"', async () => {
    const lower = await handleLookupClass({ class_name: 'ustaticmeshcomponent' }, docIndex);
    const pascal = await handleLookupClass({ class_name: 'UStaticMeshComponent' }, docIndex);
    expect(lower.isError).toBeFalsy();
    expect(pascal.isError).toBeFalsy();
    expect(lower.content[0]!.text).toContain('UStaticMeshComponent');
    expect(pascal.content[0]!.text).toContain('UStaticMeshComponent');
  });
});

// ---------------------------------------------------------------------------
// ue_get_include_path handler
// ---------------------------------------------------------------------------

describe('ue_get_include_path handler', () => {
  it('returns isError with text containing "No include path found" for unknown class name', async () => {
    const result = await handleGetIncludePath({ class_name: 'UUnknownClass99' }, docIndex);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no include path found/i);
  });

  it('returns response containing \'#include "Components/StaticMeshComponent.h"\' for UStaticMeshComponent', async () => {
    const result = await handleGetIncludePath({ class_name: 'UStaticMeshComponent' }, docIndex);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('#include "Components/StaticMeshComponent.h"');
  });

  it('response format is the exact C++ include directive (with #include and quotes)', async () => {
    const result = await handleGetIncludePath({ class_name: 'AActor' }, docIndex);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    // Should match: #include "Something/Something.h"
    expect(text).toMatch(/^#include "[^"]+\.h"$/);
  });
});

// ---------------------------------------------------------------------------
// ue_check_deprecation handler
// ---------------------------------------------------------------------------

describe('ue_check_deprecation handler', () => {
  it('returns response saying symbol is NOT deprecated for "UStaticMeshComponent"', async () => {
    const result = await handleCheckDeprecation({ symbol_name: 'UStaticMeshComponent' }, docIndex);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toMatch(/not deprecated/i);
  });

  it('returns isError with text containing "not found" for unknown symbol', async () => {
    const result = await handleCheckDeprecation({ symbol_name: 'UNonExistentSymbolXYZ' }, docIndex);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not found/i);
  });

  it('returns response indicating deprecated:true and replacement for SetSkeletalMesh (deprecated in UE 5.1)', async () => {
    // USkeletalMeshComponent.SetSkeletalMesh is deprecated in the bundled data
    const result = await handleCheckDeprecation({ symbol_name: 'SetSkeletalMesh' }, docIndex);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toMatch(/deprecated/i);
    // Should mention the replacement
    expect(text).toMatch(/SetSkeletalMeshAsset/i);
  });
});
