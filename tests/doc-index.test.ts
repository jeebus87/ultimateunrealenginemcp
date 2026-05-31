// tests/doc-index.test.ts
// TDD unit tests for DocIndex — covers all four query methods plus edge cases.
// Written in RED phase before implementation exists.

import { describe, it, expect, beforeEach } from 'vitest';
import { DocIndex } from '../src/docs/doc-index.js';
import type { ApiRecord } from '../src/docs/types.js';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_RECORDS: ApiRecord[] = [
  // Class record
  {
    id: 'UStaticMeshComponent',
    type: 'class',
    name: 'UStaticMeshComponent',
    fullName: 'UStaticMeshComponent',
    className: 'UStaticMeshComponent',
    signature: '',
    returnType: '',
    parameters: '',
    includePath: 'Components/StaticMeshComponent.h',
    module: 'Engine',
    deprecated: false,
    deprecatedMessage: '',
    replacementAPI: '',
    description: 'A component that renders a static mesh',
  },
  // Function on UStaticMeshComponent
  {
    id: 'UStaticMeshComponent.SetStaticMesh',
    type: 'function',
    name: 'SetStaticMesh',
    fullName: 'UStaticMeshComponent.SetStaticMesh',
    className: 'UStaticMeshComponent',
    signature: 'void SetStaticMesh(UStaticMesh* NewMesh)',
    returnType: 'void',
    parameters: 'UStaticMesh* NewMesh',
    includePath: 'Components/StaticMeshComponent.h',
    module: 'Engine',
    deprecated: false,
    deprecatedMessage: '',
    replacementAPI: '',
    description: 'Sets the static mesh used by this component',
  },
  // Deprecated function on AActor
  {
    id: 'AActor.GetWorld_Deprecated',
    type: 'function',
    name: 'GetWorld_Deprecated',
    fullName: 'AActor.GetWorld_Deprecated',
    className: 'AActor',
    signature: 'UWorld* GetWorld_Deprecated()',
    returnType: 'UWorld*',
    parameters: '',
    includePath: 'GameFramework/Actor.h',
    module: 'Engine',
    deprecated: true,
    deprecatedMessage: 'Use GetWorld() instead',
    replacementAPI: 'GetWorld()',
    description: 'Deprecated: Use GetWorld() instead',
  },
  // Enum record
  {
    id: 'ECollisionChannel',
    type: 'enum',
    name: 'ECollisionChannel',
    fullName: 'ECollisionChannel',
    className: 'ECollisionChannel',
    signature: '',
    returnType: '',
    parameters: '',
    includePath: 'Engine/EngineTypes.h',
    module: 'Engine',
    deprecated: false,
    deprecatedMessage: '',
    replacementAPI: '',
    description: 'Enum defining the collision channels used by Unreal Engine',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DocIndex.search', () => {
  it('returns [] for an empty index before load() is called', () => {
    const index = new DocIndex();
    expect(index.search('StaticMesh')).toEqual([]);
  });

  it('returns [] for an empty index after load([])', () => {
    const index = new DocIndex();
    index.load([]);
    expect(index.search('StaticMesh')).toEqual([]);
  });

  it('returns [] for a query matching nothing', () => {
    const index = new DocIndex();
    index.load(FIXTURE_RECORDS);
    expect(index.search('xyzzy_nonexistent_token')).toEqual([]);
  });

  it('returns results containing UStaticMeshComponent when query is "StaticMesh"', () => {
    const index = new DocIndex();
    index.load(FIXTURE_RECORDS);
    const results = index.search('StaticMesh');
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => r.record.id);
    // At least one result should be about UStaticMeshComponent
    expect(ids.some((id) => id.startsWith('UStaticMeshComponent'))).toBe(true);
  });

  it('returns results containing SetStaticMesh record when query is "SetStaticMesh"', () => {
    const index = new DocIndex();
    index.load(FIXTURE_RECORDS);
    const results = index.search('SetStaticMesh');
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => r.record.id);
    expect(ids).toContain('UStaticMeshComponent.SetStaticMesh');
  });

  it('results are ordered by score descending', () => {
    const index = new DocIndex();
    index.load(FIXTURE_RECORDS);
    const results = index.search('StaticMesh');
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it('respects optional limit parameter: search("mesh", 1) returns at most 1 result', () => {
    const index = new DocIndex();
    index.load(FIXTURE_RECORDS);
    const results = index.search('mesh', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('search is case-insensitive: "staticmesh" returns same result count as "StaticMesh"', () => {
    const index = new DocIndex();
    index.load(FIXTURE_RECORDS);
    const lower = index.search('staticmesh');
    const pascal = index.search('StaticMesh');
    expect(lower.length).toBe(pascal.length);
  });
});

describe('DocIndex.lookupClass', () => {
  let index: DocIndex;

  beforeEach(() => {
    index = new DocIndex();
    index.load(FIXTURE_RECORDS);
  });

  it('returns [] when className not in index', () => {
    expect(index.lookupClass('NonExistentClass')).toEqual([]);
  });

  it('returns all records for UStaticMeshComponent (class record + SetStaticMesh function)', () => {
    const records = index.lookupClass('UStaticMeshComponent');
    expect(records.length).toBe(2);
    const ids = records.map((r) => r.id);
    expect(ids).toContain('UStaticMeshComponent');
    expect(ids).toContain('UStaticMeshComponent.SetStaticMesh');
  });

  it('lookup is case-insensitive: "ustaticmeshcomponent" returns same results as "UStaticMeshComponent"', () => {
    const lower = index.lookupClass('ustaticmeshcomponent');
    const pascal = index.lookupClass('UStaticMeshComponent');
    expect(lower.length).toBe(pascal.length);
    expect(lower.map((r) => r.id).sort()).toEqual(pascal.map((r) => r.id).sort());
  });

  it('does NOT return records from a different class (AActor records not in UStaticMeshComponent result)', () => {
    const records = index.lookupClass('UStaticMeshComponent');
    const classNames = records.map((r) => r.className);
    expect(classNames.every((c) => c === 'UStaticMeshComponent')).toBe(true);
  });
});

describe('DocIndex.getIncludePath', () => {
  let index: DocIndex;

  beforeEach(() => {
    index = new DocIndex();
    index.load(FIXTURE_RECORDS);
  });

  it('returns null for a className not in index', () => {
    expect(index.getIncludePath('NonExistentClass')).toBeNull();
  });

  it('returns "Components/StaticMeshComponent.h" for className "UStaticMeshComponent"', () => {
    expect(index.getIncludePath('UStaticMeshComponent')).toBe('Components/StaticMeshComponent.h');
  });

  it('is case-insensitive: "ustaticmeshcomponent" returns same includePath', () => {
    expect(index.getIncludePath('ustaticmeshcomponent')).toBe('Components/StaticMeshComponent.h');
  });
});

describe('DocIndex.checkDeprecation', () => {
  let index: DocIndex;

  beforeEach(() => {
    index = new DocIndex();
    index.load(FIXTURE_RECORDS);
  });

  it('returns null for a symbolName not in index', () => {
    expect(index.checkDeprecation('NonExistentSymbol')).toBeNull();
  });

  it('returns { deprecated: false, message: "", replacement: "" } for a non-deprecated symbol', () => {
    const result = index.checkDeprecation('UStaticMeshComponent');
    expect(result).not.toBeNull();
    expect(result!.deprecated).toBe(false);
    expect(result!.message).toBe('');
    expect(result!.replacement).toBe('');
  });

  it('returns deprecation info for AActor.GetWorld_Deprecated (by fullName)', () => {
    const result = index.checkDeprecation('AActor.GetWorld_Deprecated');
    expect(result).not.toBeNull();
    expect(result!.deprecated).toBe(true);
    expect(result!.message).toBe('Use GetWorld() instead');
    expect(result!.replacement).toBe('GetWorld()');
  });

  it('returns deprecation info for GetWorld_Deprecated (by name)', () => {
    const result = index.checkDeprecation('GetWorld_Deprecated');
    expect(result).not.toBeNull();
    expect(result!.deprecated).toBe(true);
    expect(result!.message).toBe('Use GetWorld() instead');
    expect(result!.replacement).toBe('GetWorld()');
  });
});
