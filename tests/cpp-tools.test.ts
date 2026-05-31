// tests/cpp-tools.test.ts
// Integration tests for the four UE C++ MCP tool handlers.
//
// Strategy: Use real temporary directories for filesystem-based tests.
// Handler functions (handleReadCppClass, etc.) are exported and called directly.
// For index-based handlers, use buildIndexFromMap (in-memory, no fs I/O).
// ESM modules cannot be vi.spied on — all test paths use real files or real parsers.
//
// withKnownIssues integration is verified via McpServer registration mock.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared temp dir infrastructure
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-cpp-tools-test-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Helper: write a file and return its absolute path
async function writeTmpFile(relPath: string, content: string): Promise<string> {
  const absPath = path.join(tmpRoot, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf8');
  return absPath;
}

// ---------------------------------------------------------------------------
// UE C++ header fixtures
// ---------------------------------------------------------------------------

const SIMPLE_HEADER = `
#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "MyActor.generated.h"

UCLASS(BlueprintType, Blueprintable)
class MYGAME_API AMyActor : public AActor
{
    GENERATED_BODY()
public:
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Stats")
    float Health;

    UFUNCTION(BlueprintCallable, Category="Combat")
    void Attack();
};
`;

const EMPTY_HEADER = `
#pragma once
// No UCLASS in this file
#include "CoreMinimal.h"
`;

const HEADER_WITH_NO_INCLUDES = `
UCLASS()
class ANoIncludes : public AActor
{
    GENERATED_BODY()
};
`;

const COMPLEX_HEADER = `
#pragma once
#include "CoreMinimal.h"
#include "UObject/Interface.h"
#include "GameFramework/Character.h"
#include "AMyCharacter.generated.h"

UCLASS(BlueprintType, Blueprintable, ClassGroup=(Custom))
class MYGAME_API AMyCharacter : public ACharacter
{
    GENERATED_BODY()
public:
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Health", meta=(ClampMin="0", ClampMax="100"))
    float MaxHealth;

    UPROPERTY(EditAnywhere, BlueprintReadOnly, Category="Inventory")
    TArray<FItemData> Inventory;

    UFUNCTION(BlueprintCallable, Server, Reliable, WithValidation, Category="Network")
    void ServerFire(float Damage);

    UFUNCTION(BlueprintCallable, Category="Movement")
    FVector GetVelocity() const;
};
`;

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { validatePath } from '../src/utils/path-guard.js';
import { parseCppFile } from '../src/parsers/cpp-parser.js';
import { buildIndexFromMap, clearIndexCache } from '../src/parsers/cpp-class-index.js';
import { buildIndex } from '../src/parsers/cpp-class-index.js';

// ---------------------------------------------------------------------------
// ue_read_cpp_class — via parseCppFile + real fs (same path as handler)
// ---------------------------------------------------------------------------

describe('ue_read_cpp_class — handler behavior', () => {
  it('1. parseCppFile returns parsed UCLASS declarations for a valid .h file', () => {
    const result = parseCppFile(SIMPLE_HEADER);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.classes).toHaveLength(1);
    expect(result.data.classes[0]?.name).toBe('AMyActor');
    expect(result.data.classes[0]?.parentClass).toBe('AActor');
    expect(result.data.classes[0]?.specifiers).toContain('BlueprintType');
    expect(result.data.classes[0]?.specifiers).toContain('Blueprintable');
    expect(result.data.includes).toContain('CoreMinimal.h');
  });

  it('2. handler correctly reads a real file and returns parsed JSON', async () => {
    // Write real header file — PROJECT_ROOT in the module is process.cwd(),
    // so we use a path that validatePath would accept under process.cwd()
    const cwd = process.cwd();
    const testDir = path.join(cwd, '.test-tmp-cpp-tools');
    await fs.mkdir(testDir, { recursive: true });
    const filePath = path.join(testDir, 'TestActor.h');
    await fs.writeFile(filePath, SIMPLE_HEADER, 'utf8');

    try {
      const { handleReadCppClass } = await import('../src/tools/cpp/index.js');
      const result = await handleReadCppClass({ file_path: filePath });
      // Should not be an error (path is within cwd, which is PROJECT_ROOT default)
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0]?.text ?? '{}');
      expect(parsed.classes).toHaveLength(1);
      expect(parsed.classes[0].name).toBe('AMyActor');
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('3. validatePath throws for path outside project root (path traversal guard)', () => {
    const outsidePath = path.join(os.tmpdir(), 'etc', 'passwd');
    // Verify validatePath rejects the path
    expect(() => validatePath(outsidePath, tmpRoot)).toThrow('Path traversal rejected');
  });

  it('4. handler returns isError: true for path traversal attempt', async () => {
    // The handler uses PROJECT_ROOT (process.cwd() at module load time).
    // A path in os.tmpdir() (outside cwd) should be rejected.
    const outsidePath = path.join(os.tmpdir(), 'outside', 'Evil.h');
    const cwd = process.cwd();
    // Only run this assertion if os.tmpdir() is outside cwd
    const isOutside = !path.resolve(outsidePath).startsWith(path.resolve(cwd) + path.sep) &&
                      path.resolve(outsidePath) !== path.resolve(cwd);
    if (isOutside) {
      const { handleReadCppClass } = await import('../src/tools/cpp/index.js');
      // withKnownIssues wraps the handler and catches validatePath throws
      // handleReadCppClass itself will throw if validatePath throws (no inner try/catch)
      // The outer withKnownIssues wrapper returns isError: true
      // Since we call handleReadCppClass directly (not wrapped), it will throw
      await expect(handleReadCppClass({ file_path: outsidePath })).rejects.toThrow('Path traversal rejected');
    } else {
      // If cwd is inside tmpdir, skip this path test
      expect(true).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parseCppFile direct tests (verifying parser used by ue_read_cpp_class)
// ---------------------------------------------------------------------------

describe('parseCppFile — parser behavior underlying ue_read_cpp_class', () => {
  it('5. parses UCLASS with complex specifiers', () => {
    const result = parseCppFile(COMPLEX_HEADER);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const cls = result.data.classes[0]!;
    expect(cls.name).toBe('AMyCharacter');
    expect(cls.parentClass).toBe('ACharacter');
    expect(cls.specifiers).toContain('BlueprintType');
    expect(cls.specifiers).toContain('Blueprintable');
    // ClassGroup=(Custom) is a specifier token (not meta), verify it's present
    const hasClassGroup = cls.specifiers.some(s => s.startsWith('ClassGroup'));
    expect(hasClassGroup).toBe(true);
  });

  it('6. parses UPROPERTY with meta=(ClampMin, ClampMax) correctly', () => {
    const result = parseCppFile(COMPLEX_HEADER);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const prop = result.data.classes[0]?.properties.find(p => p.name === 'MaxHealth');
    expect(prop).toBeDefined();
    expect(prop?.type).toBe('float');
    expect(prop?.specifiers).toContain('EditAnywhere');
    expect(prop?.meta['ClampMin']).toBe('0');
    expect(prop?.meta['ClampMax']).toBe('100');
  });

  it('7. parses UFUNCTION with Server+Reliable+WithValidation specifiers', () => {
    const result = parseCppFile(COMPLEX_HEADER);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const fn = result.data.classes[0]?.functions.find(f => f.name === 'ServerFire');
    expect(fn).toBeDefined();
    expect(fn?.specifiers).toContain('Server');
    expect(fn?.specifiers).toContain('Reliable');
    expect(fn?.specifiers).toContain('WithValidation');
  });

  it('8. handles file with no UCLASS — returns empty classes array (not error)', () => {
    const result = parseCppFile(EMPTY_HEADER);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.classes).toHaveLength(0);
    expect(result.data.includes).toContain('CoreMinimal.h');
  });
});

// ---------------------------------------------------------------------------
// ue_get_class_hierarchy — via buildIndexFromMap (deterministic)
// ---------------------------------------------------------------------------

describe('ue_get_class_hierarchy — buildIndex integration', () => {
  beforeEach(() => clearIndexCache());

  it('9. returns inheritance chain for a known class', async () => {
    const files: Record<string, string> = {
      '/fake/Source/AActor.h': `
        UCLASS()
        class AActor : public UObject { GENERATED_BODY() };
      `,
      '/fake/Source/AMyActor.h': `
        UCLASS()
        class AMyActor : public AActor { GENERATED_BODY() };
      `,
    };
    const indexResult = await buildIndexFromMap(files);
    expect(indexResult.success).toBe(true);
    if (!indexResult.success) return;

    const chain = indexResult.index.getClassHierarchy('AMyActor');
    expect(chain[0]).toBe('AMyActor');
    expect(chain[1]).toBe('AActor');
    expect(chain.length).toBe(2);
  });

  it('10. returns chain of length 1 for unknown class (class not in index)', async () => {
    const indexResult = await buildIndexFromMap({});
    expect(indexResult.success).toBe(true);
    if (!indexResult.success) return;

    const chain = indexResult.index.getClassHierarchy('AUnknownClass');
    expect(chain).toEqual(['AUnknownClass']);
    expect(chain.length).toBe(1);
  });

  it('11. buildIndex returns success:false when Source/ directory does not exist', async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-no-source-'));
    try {
      clearIndexCache();
      const result = await buildIndex(emptyRoot);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Source/');
      }
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true });
      clearIndexCache();
    }
  });
});

// ---------------------------------------------------------------------------
// ue_trace_includes — handleTraceIncludes
// ---------------------------------------------------------------------------

describe('ue_trace_includes — handler behavior', () => {
  it('12. returns includes list for a valid header with multiple #include directives', () => {
    const result = parseCppFile(SIMPLE_HEADER);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.includes).toContain('CoreMinimal.h');
    expect(result.data.includes).toContain('GameFramework/Actor.h');
    expect(result.data.includes).toContain('MyActor.generated.h');
    expect(result.data.includes).toHaveLength(3);
  });

  it('13. returns empty array for a file with no #include directives (not an error)', () => {
    const result = parseCppFile(HEADER_WITH_NO_INCLUDES);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.includes).toHaveLength(0);
  });

  it('14. validatePath throws for path outside project root (path traversal guard)', () => {
    const outsidePath = '/etc/passwd';
    expect(() => validatePath(outsidePath, tmpRoot)).toThrow('Path traversal rejected');
  });

  it('15. returns correct includes for the complex header fixture (4 includes)', () => {
    const result = parseCppFile(COMPLEX_HEADER);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.includes).toContain('CoreMinimal.h');
    expect(result.data.includes).toContain('UObject/Interface.h');
    expect(result.data.includes).toContain('GameFramework/Character.h');
    expect(result.data.includes).toContain('AMyCharacter.generated.h');
    expect(result.data.includes).toHaveLength(4);
  });

  it('16. handleTraceIncludes reads real file and returns parsed includes', async () => {
    // Write a real file inside process.cwd() (default PROJECT_ROOT)
    const cwd = process.cwd();
    const testDir = path.join(cwd, '.test-tmp-trace-includes');
    await fs.mkdir(testDir, { recursive: true });
    const filePath = path.join(testDir, 'TraceTest.h');
    await fs.writeFile(filePath, SIMPLE_HEADER, 'utf8');

    try {
      const { handleTraceIncludes } = await import('../src/tools/cpp/index.js');
      const result = await handleTraceIncludes({ file_path: filePath });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0]?.text ?? '{}');
      expect(parsed.includes).toContain('CoreMinimal.h');
      expect(parsed.includes).toContain('GameFramework/Actor.h');
      expect(parsed.filePath).toBe(filePath);
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ue_find_class_file — via buildIndexFromMap
// ---------------------------------------------------------------------------

describe('ue_find_class_file — buildIndexFromMap integration', () => {
  beforeEach(() => clearIndexCache());

  it('17. returns { header, source } for a known class', async () => {
    const files: Record<string, string> = {
      '/fake/Source/AMyActor.h': `
        UCLASS()
        class AMyActor : public AActor { GENERATED_BODY() };
      `,
    };
    const indexResult = await buildIndexFromMap(files);
    expect(indexResult.success).toBe(true);
    if (!indexResult.success) return;

    const found = indexResult.index.findClassFile('AMyActor');
    expect(found).not.toBeNull();
    expect(found?.header).toBe('/fake/Source/AMyActor.h');
    expect(found).toHaveProperty('source');
  });

  it('18. returns null for an unknown class name (not isError — "not found" message)', async () => {
    const indexResult = await buildIndexFromMap({});
    expect(indexResult.success).toBe(true);
    if (!indexResult.success) return;

    const found = indexResult.index.findClassFile('AUnknownClass');
    expect(found).toBeNull();
  });

  it('19. buildIndex returns error when Source/ directory cannot be read', async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-no-source-2-'));
    try {
      clearIndexCache();
      const result = await buildIndex(emptyRoot);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Cannot read Source/);
      }
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true });
      clearIndexCache();
    }
  });

  it('20. returns header path for interface class (source: null when no .cpp companion)', async () => {
    const files: Record<string, string> = {
      '/fake/Source/UMyInterface.h': `
        UCLASS()
        class UMyInterface : public UInterface { GENERATED_BODY() };
      `,
    };
    const indexResult = await buildIndexFromMap(files);
    expect(indexResult.success).toBe(true);
    if (!indexResult.success) return;

    const found = indexResult.index.findClassFile('UMyInterface');
    expect(found).not.toBeNull();
    expect(found?.header).toBe('/fake/Source/UMyInterface.h');
    expect(found?.source).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withKnownIssues wrapper integration
// ---------------------------------------------------------------------------

describe('withKnownIssues wrapper — cpp tool registration', () => {
  it('21. registerCppTools registers all eight tool names on McpServer', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { registerCppTools } = await import('../src/tools/cpp/index.js');

    const registeredTools: string[] = [];
    const mockServer = {
      registerTool: (name: string, _def: unknown, _handler: unknown) => {
        registeredTools.push(name);
      },
    } as unknown as InstanceType<typeof McpServer>;

    registerCppTools(mockServer);

    // Read tools (CPP-01 through CPP-04)
    expect(registeredTools).toContain('ue_read_cpp_class');
    expect(registeredTools).toContain('ue_get_class_hierarchy');
    expect(registeredTools).toContain('ue_trace_includes');
    expect(registeredTools).toContain('ue_find_class_file');
    // Generation tools (GEN-01 through GEN-08)
    expect(registeredTools).toContain('ue_generate_class');
    expect(registeredTools).toContain('ue_add_property');
    expect(registeredTools).toContain('ue_add_function');
    expect(registeredTools).toContain('ue_add_include');
    expect(registeredTools).toHaveLength(8);
  });

  it('22. withKnownIssues catches exceptions thrown by handlers and returns isError response', async () => {
    const { withKnownIssues } = await import('../src/tools/known-issues/middleware.js');

    const throwingHandler = async (_args: { value: string }) => {
      throw new Error('Test handler exception from cpp tools test');
    };

    const wrapped = withKnownIssues('test_cpp_tool', throwingHandler);
    const result = await wrapped({ value: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Test handler exception from cpp tools test');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('23. parseCppFile handles template property type TArray<FHitResult>', () => {
    const header = `
      UCLASS()
      class ATestActor : public AActor {
        GENERATED_BODY()
        UPROPERTY(EditAnywhere)
        TArray<FHitResult> HitResults;
      };
    `;
    const result = parseCppFile(header);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const prop = result.data.classes[0]?.properties[0];
    expect(prop?.name).toBe('HitResults');
    expect(prop?.type).toBe('TArray<FHitResult>');
  });

  it('24. parseCppFile handles pointer property type AActor*', () => {
    const header = `
      UCLASS()
      class ATestActor : public AActor {
        GENERATED_BODY()
        UPROPERTY(EditAnywhere)
        AActor* TargetActor;
      };
    `;
    const result = parseCppFile(header);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const prop = result.data.classes[0]?.properties[0];
    expect(prop?.name).toBe('TargetActor');
    expect(prop?.type).toBe('AActor*');
  });

  it('25. buildIndexFromMap handles 3-level inheritance chain correctly', async () => {
    clearIndexCache();
    const files: Record<string, string> = {
      '/fake/Source/AActor.h': `
        UCLASS()
        class AActor : public UObject { GENERATED_BODY() };
      `,
      '/fake/Source/APawn.h': `
        UCLASS()
        class APawn : public AActor { GENERATED_BODY() };
      `,
      '/fake/Source/ACharacter.h': `
        UCLASS()
        class ACharacter : public APawn { GENERATED_BODY() };
      `,
    };
    const indexResult = await buildIndexFromMap(files);
    expect(indexResult.success).toBe(true);
    if (!indexResult.success) return;

    expect(indexResult.fileCount).toBe(3);

    const chain = indexResult.index.getClassHierarchy('ACharacter');
    expect(chain[0]).toBe('ACharacter');
    expect(chain[1]).toBe('APawn');
    expect(chain[2]).toBe('AActor');
    expect(chain).toHaveLength(3);
  });

  it('26. buildIndexFromMap cycle detection terminates without infinite loop', async () => {
    clearIndexCache();
    const files: Record<string, string> = {
      '/fake/Source/ACycleA.h': `
        UCLASS()
        class ACycleA : public ACycleB { GENERATED_BODY() };
      `,
      '/fake/Source/ACycleB.h': `
        UCLASS()
        class ACycleB : public ACycleA { GENERATED_BODY() };
      `,
    };
    const indexResult = await buildIndexFromMap(files);
    expect(indexResult.success).toBe(true);
    if (!indexResult.success) return;

    const chain = indexResult.index.getClassHierarchy('ACycleA');
    // Should terminate; chain has 2 elements (ACycleA, ACycleB)
    expect(chain.length).toBe(2);
    expect(chain[0]).toBe('ACycleA');
    expect(chain[1]).toBe('ACycleB');
  });

  it('27. getIncludes returns correct list for a class in the index', async () => {
    clearIndexCache();
    const files: Record<string, string> = {
      '/fake/Source/AMyActor.h': SIMPLE_HEADER,
    };
    const indexResult = await buildIndexFromMap(files);
    expect(indexResult.success).toBe(true);
    if (!indexResult.success) return;

    const includes = indexResult.index.getIncludes('AMyActor');
    expect(includes).toContain('CoreMinimal.h');
    expect(includes).toContain('GameFramework/Actor.h');
    expect(includes).toContain('MyActor.generated.h');
  });

  it('28. getIncludes returns empty array for class not in index', async () => {
    clearIndexCache();
    const indexResult = await buildIndexFromMap({});
    expect(indexResult.success).toBe(true);
    if (!indexResult.success) return;

    const includes = indexResult.index.getIncludes('ANotInIndex');
    expect(includes).toEqual([]);
  });

  it('29. validatePath allows file path exactly at project root (same path)', () => {
    const resolved = validatePath(tmpRoot, tmpRoot);
    expect(resolved).toBe(path.resolve(tmpRoot));
  });

  it('30. parseCppFile result contains rawContent matching input string', () => {
    const result = parseCppFile(SIMPLE_HEADER);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rawContent).toBe(SIMPLE_HEADER);
  });
});
