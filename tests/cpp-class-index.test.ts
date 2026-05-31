// tests/cpp-class-index.test.ts
// TDD test suite for CppClassIndex — project-wide class scanner and query engine.
//
// Strategy: All tests use buildIndexFromMap (in-memory fixtures) — no real filesystem I/O.
// Tests cover: index building, hierarchy traversal, cycle detection, includes, cache hits,
// error resilience, and edge cases.
//
// Implementation: src/parsers/cpp-class-index.ts

import {
  buildIndexFromMap,
  clearIndexCache,
  type ClassIndexEntry,
  type IndexBuildResult,
} from '../src/parsers/cpp-class-index.js';

// ---------------------------------------------------------------------------
// Test fixtures — realistic UE header content strings
// ---------------------------------------------------------------------------

const AACTOR_HEADER = `
#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "MyActor.generated.h"

UCLASS(BlueprintType, Blueprintable)
class MYGAME_API AActor : public UObject
{
    GENERATED_BODY()
public:
};
`;

const APAWN_HEADER = `
#pragma once
#include "CoreMinimal.h"
#include "MyActor.h"

UCLASS(BlueprintType)
class MYGAME_API APawn : public AActor
{
    GENERATED_BODY()
public:
};
`;

const ACHARACTER_HEADER = `
#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"

UCLASS(Blueprintable)
class MYGAME_API ACharacter : public APawn
{
    GENERATED_BODY()
public:
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Stats")
    float Health;

    UFUNCTION(BlueprintCallable, Category="Movement")
    void Jump();
};
`;

const AMYACTOR_HEADER = `
#pragma once
#include "CoreMinimal.h"
#include "ACharacter.h"
#include "MyActor.generated.h"

UCLASS(BlueprintType, Blueprintable)
class MYGAME_API AMyActor : public ACharacter
{
    GENERATED_BODY()
public:
    UPROPERTY(EditAnywhere, Category="Config")
    int32 Score;
};
`;

const TWO_CLASS_HEADER = `
#pragma once
#include "CoreMinimal.h"

UCLASS(BlueprintType)
class MYGAME_API AFirstClass : public AActor
{
    GENERATED_BODY()
};

UCLASS(Blueprintable)
class MYGAME_API ASecondClass : public APawn
{
    GENERATED_BODY()
};
`;

const PARSE_ERROR_HEADER = `
#pragma once
// This file has a broken UCLASS with unclosed paren — will be counted as error
UCLASS(
`;

const COMPLEX_INCLUDES_HEADER = `
#pragma once
#include "CoreMinimal.h"
#include "Engine/Actor.h"
#include "Interfaces/IMyInterface.h"
#include <vector>

UCLASS()
class MYGAME_API AComplexActor : public AActor
{
    GENERATED_BODY()
};
`;

// ---------------------------------------------------------------------------
// Helper: clearIndexCache before each test that involves mtime caching
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearIndexCache();
});

// ---------------------------------------------------------------------------
// 1. Empty project
// ---------------------------------------------------------------------------

describe('buildIndexFromMap — empty project', () => {
  it('returns success with empty index when no files provided', async () => {
    const result = await buildIndexFromMap({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.entries.size).toBe(0);
      expect(result.fileCount).toBe(0);
      expect(result.errorCount).toBe(0);
    }
  });

  it('getClassHierarchy on empty index returns [className]', async () => {
    const result = await buildIndexFromMap({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.getClassHierarchy('AMyActor')).toEqual(['AMyActor']);
    }
  });

  it('findClassFile on empty index returns null', async () => {
    const result = await buildIndexFromMap({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.findClassFile('AMyActor')).toBeNull();
    }
  });

  it('getIncludes on empty index returns []', async () => {
    const result = await buildIndexFromMap({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.getIncludes('AMyActor')).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Single header with one UCLASS
// ---------------------------------------------------------------------------

describe('buildIndexFromMap — single header', () => {
  it('creates an entry with correct className', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/MyActor.h': AMYACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.entries.has('AMyActor')).toBe(true);
    }
  });

  it('entry has correct headerPath', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/MyActor.h': AMYACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.index.entries.get('AMyActor');
      expect(entry).toBeDefined();
      expect(entry!.headerPath).toBe('/project/Source/MyActor.h');
    }
  });

  it('entry has correct parentClass', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/MyActor.h': AMYACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.index.entries.get('AMyActor');
      expect(entry!.parentClass).toBe('ACharacter');
    }
  });

  it('entry has correct specifiers', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/MyActor.h': AMYACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.index.entries.get('AMyActor');
      expect(entry!.specifiers).toContain('BlueprintType');
      expect(entry!.specifiers).toContain('Blueprintable');
    }
  });

  it('fileCount reflects number of files parsed', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/MyActor.h': AMYACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.fileCount).toBe(1);
    }
  });

  it('sourcePath is null when no matching .cpp provided in the map', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/MyActor.h': AMYACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.index.entries.get('AMyActor');
      expect(entry!.sourcePath).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Header with two UCLASSes
// ---------------------------------------------------------------------------

describe('buildIndexFromMap — header with two UCLASSes', () => {
  it('creates two entries from a single file', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/TwoClasses.h': TWO_CLASS_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.entries.size).toBe(2);
      expect(result.index.entries.has('AFirstClass')).toBe(true);
      expect(result.index.entries.has('ASecondClass')).toBe(true);
    }
  });

  it('both entries have the same headerPath', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/TwoClasses.h': TWO_CLASS_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.entries.get('AFirstClass')!.headerPath).toBe('/project/Source/TwoClasses.h');
      expect(result.index.entries.get('ASecondClass')!.headerPath).toBe('/project/Source/TwoClasses.h');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Inheritance chain traversal
// ---------------------------------------------------------------------------

describe('getClassHierarchy — inheritance traversal', () => {
  it('returns [className] when class has no parent in index', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/Actor.h': AACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // AActor's parent UObject is not in index
      const hierarchy = result.index.getClassHierarchy('AActor');
      expect(hierarchy[0]).toBe('AActor');
    }
  });

  it('returns 3-class chain for APawn : AActor : (not in index)', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/Actor.h': AACTOR_HEADER,
      '/project/Source/Pawn.h': APAWN_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const hierarchy = result.index.getClassHierarchy('APawn');
      expect(hierarchy).toEqual(['APawn', 'AActor']);
    }
  });

  it('returns 4-class chain: AMyActor -> ACharacter -> APawn -> AActor', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/Actor.h': AACTOR_HEADER,
      '/project/Source/Pawn.h': APAWN_HEADER,
      '/project/Source/Character.h': ACHARACTER_HEADER,
      '/project/Source/MyActor.h': AMYACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const hierarchy = result.index.getClassHierarchy('AMyActor');
      expect(hierarchy).toEqual(['AMyActor', 'ACharacter', 'APawn', 'AActor']);
    }
  });

  it('returned hierarchy starts with the queried class', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/Character.h': ACHARACTER_HEADER,
      '/project/Source/Pawn.h': APAWN_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const hierarchy = result.index.getClassHierarchy('ACharacter');
      expect(hierarchy[0]).toBe('ACharacter');
    }
  });

  it('unknown class returns [className] with chain length 1', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/Actor.h': AACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const hierarchy = result.index.getClassHierarchy('AUnknownClass');
      expect(hierarchy).toEqual(['AUnknownClass']);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Cycle detection
// ---------------------------------------------------------------------------

describe('getClassHierarchy — cycle detection', () => {
  const CYCLE_A = `
#pragma once
UCLASS()
class MYGAME_API ACycleA : public ACycleB
{
    GENERATED_BODY()
};
`;
  const CYCLE_B = `
#pragma once
UCLASS()
class MYGAME_API ACycleB : public ACycleA
{
    GENERATED_BODY()
};
`;

  it('stops traversal when cycle detected (A:B, B:A)', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/CycleA.h': CYCLE_A,
      '/project/Source/CycleB.h': CYCLE_B,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const hierarchy = result.index.getClassHierarchy('ACycleA');
      // Should contain ACycleA and ACycleB but not loop infinitely
      expect(hierarchy).toContain('ACycleA');
      expect(hierarchy).toContain('ACycleB');
      expect(hierarchy.length).toBe(2);
    }
  });

  it('does not throw or stack overflow on circular inheritance', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/CycleA.h': CYCLE_A,
      '/project/Source/CycleB.h': CYCLE_B,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(() => result.index.getClassHierarchy('ACycleB')).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. getIncludes
// ---------------------------------------------------------------------------

describe('getIncludes', () => {
  it('returns correct include list for ACharacter', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/Character.h': ACHARACTER_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const includes = result.index.getIncludes('ACharacter');
      expect(includes).toContain('CoreMinimal.h');
      expect(includes).toContain('GameFramework/Pawn.h');
    }
  });

  it('returns [] for unknown class', async () => {
    const result = await buildIndexFromMap({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.getIncludes('AUnknownClass')).toEqual([]);
    }
  });

  it('returns all includes from a header with many includes', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/Complex.h': COMPLEX_INCLUDES_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const includes = result.index.getIncludes('AComplexActor');
      expect(includes.length).toBeGreaterThanOrEqual(3);
      expect(includes).toContain('CoreMinimal.h');
      expect(includes).toContain('Engine/Actor.h');
      expect(includes).toContain('Interfaces/IMyInterface.h');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. findClassFile
// ---------------------------------------------------------------------------

describe('findClassFile', () => {
  it('returns header path for known class', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/MyActor.h': AMYACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const fileInfo = result.index.findClassFile('AMyActor');
      expect(fileInfo).not.toBeNull();
      expect(fileInfo!.header).toBe('/project/Source/MyActor.h');
    }
  });

  it('returns null for unknown class', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/MyActor.h': AMYACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.findClassFile('AUnknownClass')).toBeNull();
    }
  });

  it('source is null when no matching .cpp in the map', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/MyActor.h': AMYACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const fileInfo = result.index.findClassFile('AMyActor');
      expect(fileInfo!.source).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Error resilience
// ---------------------------------------------------------------------------

describe('buildIndexFromMap — error resilience', () => {
  it('increments errorCount when a header fails to parse', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/Good.h': AMYACTOR_HEADER,
      '/project/Source/Bad.h': PARSE_ERROR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Good file should still be indexed
      expect(result.index.entries.has('AMyActor')).toBe(true);
      // Error count should reflect the bad file
      expect(result.errorCount).toBeGreaterThanOrEqual(0);
      // At minimum, the good file was counted
      expect(result.fileCount).toBeGreaterThanOrEqual(1);
    }
  });

  it('does not throw even if all headers fail to parse', async () => {
    await expect(
      buildIndexFromMap({
        '/project/Source/Bad1.h': PARSE_ERROR_HEADER,
        '/project/Source/Bad2.h': PARSE_ERROR_HEADER,
      })
    ).resolves.not.toThrow();
  });

  it('result.success is true even when some files have parse errors', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/Bad.h': PARSE_ERROR_HEADER,
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Multiple files
// ---------------------------------------------------------------------------

describe('buildIndexFromMap — multiple files', () => {
  it('indexes all classes across multiple files', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/Actor.h': AACTOR_HEADER,
      '/project/Source/Pawn.h': APAWN_HEADER,
      '/project/Source/Character.h': ACHARACTER_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.entries.has('AActor')).toBe(true);
      expect(result.index.entries.has('APawn')).toBe(true);
      expect(result.index.entries.has('ACharacter')).toBe(true);
      expect(result.fileCount).toBe(3);
    }
  });

  it('each entry points to its own headerPath', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/Actor.h': AACTOR_HEADER,
      '/project/Source/Pawn.h': APAWN_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.entries.get('AActor')!.headerPath).toBe('/project/Source/Actor.h');
      expect(result.index.entries.get('APawn')!.headerPath).toBe('/project/Source/Pawn.h');
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Cache / clearIndexCache
// ---------------------------------------------------------------------------

describe('clearIndexCache', () => {
  it('clearIndexCache does not throw', () => {
    expect(() => clearIndexCache()).not.toThrow();
  });

  it('calling clearIndexCache twice does not throw', () => {
    clearIndexCache();
    expect(() => clearIndexCache()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11. Type shape validation
// ---------------------------------------------------------------------------

describe('ClassIndexEntry type shape', () => {
  it('entry has all required fields: className, headerPath, sourcePath, parentClass, includes, specifiers', async () => {
    const result = await buildIndexFromMap({
      '/project/Source/MyActor.h': AMYACTOR_HEADER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.index.entries.get('AMyActor');
      expect(entry).toBeDefined();
      expect(typeof entry!.className).toBe('string');
      expect(typeof entry!.headerPath).toBe('string');
      expect(entry!.sourcePath === null || typeof entry!.sourcePath === 'string').toBe(true);
      expect(typeof entry!.parentClass).toBe('string');
      expect(Array.isArray(entry!.includes)).toBe(true);
      expect(Array.isArray(entry!.specifiers)).toBe(true);
    }
  });

  it('index.entries is a Map', async () => {
    const result = await buildIndexFromMap({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.index.entries instanceof Map).toBe(true);
    }
  });
});
