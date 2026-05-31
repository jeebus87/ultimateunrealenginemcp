// tests/cpp-gen-tools.test.ts
// Integration tests for the four UE C++ generation MCP tool handlers.
// GEN-01 through GEN-08.
//
// Strategy: real temp dirs WITHIN process.cwd() (PROJECT_ROOT at test time),
// so validatePath() does not reject the paths.
// Direct handler function calls — no McpServer mocking needed for handler tests.
// Validates: file creation, content correctness, error paths, UHT rules, path guard.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Temp dir under cwd (within PROJECT_ROOT) to pass validatePath()
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  // Use a subdirectory of cwd so validatePath accepts these paths.
  // PROJECT_ROOT defaults to process.cwd() in config.ts.
  const suffix = Math.random().toString(36).slice(2, 8);
  tmpRoot = path.join(process.cwd(), `.test-tmp-gen-tools-${suffix}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeTmpFile(relPath: string, content: string): Promise<string> {
  const absPath = path.join(tmpRoot, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf8');
  return absPath;
}

// ---------------------------------------------------------------------------
// UE C++ header fixture for modification tests
// ---------------------------------------------------------------------------

const BASE_ACTOR_HEADER = `#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "AMyActor.generated.h"

UCLASS(BlueprintType, Blueprintable)
class MYGAME_API AMyActor : public AActor
{
\tGENERATED_BODY()

public:
\tAMyActor();

\tUPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Stats")
\tfloat Health;

\tUFUNCTION(BlueprintCallable, Category="Combat")
\tvoid Attack();
};
`;

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  handleGenerateClass,
  handleAddProperty,
  handleAddFunction,
  handleAddInclude,
  registerCppTools,
} from '../src/tools/cpp/index.js';

// ---------------------------------------------------------------------------
// handleGenerateClass — GEN-01 through GEN-04, GEN-08
// ---------------------------------------------------------------------------

describe('handleGenerateClass — GEN-01 through GEN-04, GEN-08', () => {
  it('1. generates Actor class — creates .h and .cpp in output_dir and returns their paths', async () => {
    const result = await handleGenerateClass({
      class_type: 'Actor',
      class_name: 'MyActor',
      module_name: 'MyGame',
      output_dir: tmpRoot,
    });

    expect(result.isError).toBeFalsy();
    await expect(fs.access(path.join(tmpRoot, 'AMyActor.h'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpRoot, 'AMyActor.cpp'))).resolves.toBeUndefined();
    expect(result.content[0]?.text).toContain('AMyActor.h');
  });

  it('2. generated header contains UCLASS(), GENERATED_BODY(), and AActor parent', async () => {
    await handleGenerateClass({
      class_type: 'Actor',
      class_name: 'MyActor',
      module_name: 'MyGame',
      output_dir: tmpRoot,
    });

    const header = await fs.readFile(path.join(tmpRoot, 'AMyActor.h'), 'utf8');
    expect(header).toContain('UCLASS(');
    expect(header).toContain('GENERATED_BODY()');
    expect(header).toContain(': public AActor');
  });

  it('3. generated header has .generated.h as the last #include', async () => {
    await handleGenerateClass({
      class_type: 'Actor',
      class_name: 'MyActor',
      module_name: 'MyGame',
      output_dir: tmpRoot,
    });

    const header = await fs.readFile(path.join(tmpRoot, 'AMyActor.h'), 'utf8');
    const includeLines = header.split('\n').filter((ln) => ln.trim().startsWith('#include'));
    expect(includeLines.length).toBeGreaterThan(0);
    const lastInclude = includeLines[includeLines.length - 1] ?? '';
    expect(lastInclude).toMatch(/\.generated\.h/);
  });

  it('4. generated .cpp contains BeginPlay and Tick overrides', async () => {
    await handleGenerateClass({
      class_type: 'Actor',
      class_name: 'MyActor',
      module_name: 'MyGame',
      output_dir: tmpRoot,
    });

    const cpp = await fs.readFile(path.join(tmpRoot, 'AMyActor.cpp'), 'utf8');
    expect(cpp).toContain('BeginPlay');
    expect(cpp).toContain('Tick');
  });

  it('5. generates Interface class with dual UINTERFACE + IInterface pattern', async () => {
    const result = await handleGenerateClass({
      class_type: 'Interface',
      class_name: 'MyInterface',
      module_name: 'MyGame',
      output_dir: tmpRoot,
    });

    expect(result.isError).toBeFalsy();
    const header = await fs.readFile(path.join(tmpRoot, 'IMyInterface.h'), 'utf8');
    expect(header).toContain('UMyInterface');
    expect(header).toContain('IMyInterface');
    expect(header).toContain('UInterface');
    expect(header).toContain('MinimalAPI');
  });

  it('6. generates GameMode class extending AGameModeBase', async () => {
    const result = await handleGenerateClass({
      class_type: 'GameMode',
      class_name: 'MyGameMode',
      module_name: 'MyGame',
      output_dir: tmpRoot,
    });

    expect(result.isError).toBeFalsy();
    const header = await fs.readFile(path.join(tmpRoot, 'AMyGameMode.h'), 'utf8');
    expect(header).toContain('AGameModeBase');
  });

  it('7. returns isError for unknown class_type', async () => {
    const result = await handleGenerateClass({
      class_type: 'Widget',
      class_name: 'X',
      module_name: 'M',
      output_dir: tmpRoot,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Widget');
  });

  it('8. success response includes hot-reload warning', async () => {
    const result = await handleGenerateClass({
      class_type: 'Actor',
      class_name: 'MyActor',
      module_name: 'MyGame',
      output_dir: tmpRoot,
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    const hasWarning =
      text.includes('Restart') ||
      text.includes('Hot Reload') ||
      text.includes('restart');
    expect(hasWarning).toBe(true);
  });

  it('9. rejects output_dir outside project root (path traversal guard)', async () => {
    const cwd = process.cwd();
    const outsideDir = path.join(os.tmpdir(), 'outside-project-root');
    const isOutside =
      !path.resolve(outsideDir).startsWith(path.resolve(cwd) + path.sep) &&
      path.resolve(outsideDir) !== path.resolve(cwd);

    if (!isOutside) {
      // If os.tmpdir() happens to be inside cwd, skip gracefully
      expect(true).toBe(true);
      return;
    }

    // Handler throws validatePath error (withKnownIssues is not applied at this level)
    await expect(
      handleGenerateClass({
        class_type: 'Actor',
        class_name: 'Evil',
        module_name: 'Evil',
        output_dir: outsideDir,
      })
    ).rejects.toThrow('Path traversal rejected');
  });
});

// ---------------------------------------------------------------------------
// handleAddProperty — GEN-05, GEN-08
// ---------------------------------------------------------------------------

describe('handleAddProperty — GEN-05, GEN-08', () => {
  it('10. adds UPROPERTY to existing class and overwrites file on disk', async () => {
    const headerPath = await writeTmpFile('MyActor.h', BASE_ACTOR_HEADER);

    const result = await handleAddProperty({
      file_path: headerPath,
      class_name: 'AMyActor',
      specifiers: ['EditAnywhere'],
      type: 'int32',
      name: 'Score',
    });

    expect(result.isError).toBeFalsy();
    const updated = await fs.readFile(headerPath, 'utf8');
    expect(updated).toContain('UPROPERTY(EditAnywhere)');
    expect(updated).toContain('int32 Score');
  });

  it('11. returns isError when class_name not found in file', async () => {
    const headerPath = await writeTmpFile('MyActor.h', BASE_ACTOR_HEADER);

    const result = await handleAddProperty({
      file_path: headerPath,
      class_name: 'ANotHere',
      specifiers: [],
      type: 'float',
      name: 'X',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ANotHere');
  });

  it('12. returns error for file path outside project root', async () => {
    const cwd = process.cwd();
    const outsidePath = path.join(os.tmpdir(), 'outside', 'Evil.h');
    const isOutside =
      !path.resolve(outsidePath).startsWith(path.resolve(cwd) + path.sep) &&
      path.resolve(outsidePath) !== path.resolve(cwd);

    if (!isOutside) {
      expect(true).toBe(true);
      return;
    }

    await expect(
      handleAddProperty({
        file_path: outsidePath,
        class_name: 'AEvil',
        specifiers: [],
        type: 'float',
        name: 'X',
      })
    ).rejects.toThrow('Path traversal rejected');
  });
});

// ---------------------------------------------------------------------------
// handleAddFunction — GEN-06, GEN-08
// ---------------------------------------------------------------------------

describe('handleAddFunction — GEN-06, GEN-08', () => {
  it('13. adds UFUNCTION to existing class and overwrites file on disk', async () => {
    const headerPath = await writeTmpFile('MyActor.h', BASE_ACTOR_HEADER);

    const result = await handleAddFunction({
      file_path: headerPath,
      class_name: 'AMyActor',
      specifiers: ['BlueprintCallable'],
      return_type: 'void',
      name: 'Heal',
      params: 'float Amount',
    });

    expect(result.isError).toBeFalsy();
    const updated = await fs.readFile(headerPath, 'utf8');
    expect(updated).toContain('UFUNCTION(BlueprintCallable)');
    expect(updated).toContain('void Heal(float Amount)');
  });

  it('14. returns isError when class_name not found in file', async () => {
    const headerPath = await writeTmpFile('MyActor.h', BASE_ACTOR_HEADER);

    const result = await handleAddFunction({
      file_path: headerPath,
      class_name: 'ANotHere',
      specifiers: ['BlueprintCallable'],
      return_type: 'void',
      name: 'Heal',
    });

    expect(result.isError).toBe(true);
  });

  it('15. supports const function (is_const: true appends "const" to declaration)', async () => {
    const headerPath = await writeTmpFile('MyActor.h', BASE_ACTOR_HEADER);

    const result = await handleAddFunction({
      file_path: headerPath,
      class_name: 'AMyActor',
      specifiers: ['BlueprintCallable'],
      return_type: 'float',
      name: 'GetHealth',
      is_const: true,
    });

    expect(result.isError).toBeFalsy();
    const updated = await fs.readFile(headerPath, 'utf8');
    expect(updated).toContain('float GetHealth() const');
  });
});

// ---------------------------------------------------------------------------
// handleAddInclude — GEN-07
// ---------------------------------------------------------------------------

describe('handleAddInclude — GEN-07', () => {
  it('16. adds include to existing header file before .generated.h', async () => {
    const headerPath = await writeTmpFile('MyActor.h', BASE_ACTOR_HEADER);

    const result = await handleAddInclude({
      file_path: headerPath,
      include_path: '"Engine/StaticMeshActor.h"',
    });

    expect(result.isError).toBeFalsy();
    const updated = await fs.readFile(headerPath, 'utf8');
    expect(updated).toContain('#include "Engine/StaticMeshActor.h"');

    // .generated.h line must still be the last include
    const includeLines = updated.split('\n').filter((ln) => ln.trim().startsWith('#include'));
    const lastInclude = includeLines[includeLines.length - 1] ?? '';
    expect(lastInclude).toMatch(/\.generated\.h/);
  });

  it('17. is idempotent — calling twice does not create duplicate include', async () => {
    const headerPath = await writeTmpFile('MyActor.h', BASE_ACTOR_HEADER);

    // BASE_ACTOR_HEADER already contains CoreMinimal.h — add it again
    await handleAddInclude({ file_path: headerPath, include_path: '"CoreMinimal.h"' });
    const updated = await fs.readFile(headerPath, 'utf8');

    // Count occurrences of #include "CoreMinimal.h"
    const matches = (updated.match(/#include "CoreMinimal\.h"/g) ?? []).length;
    expect(matches).toBe(1);
  });

  it('18. returns error for file path outside project root', async () => {
    const cwd = process.cwd();
    const outsidePath = path.join(os.tmpdir(), 'outside', 'Evil.h');
    const isOutside =
      !path.resolve(outsidePath).startsWith(path.resolve(cwd) + path.sep) &&
      path.resolve(outsidePath) !== path.resolve(cwd);

    if (!isOutside) {
      expect(true).toBe(true);
      return;
    }

    await expect(
      handleAddInclude({
        file_path: outsidePath,
        include_path: '"SomeHeader.h"',
      })
    ).rejects.toThrow('Path traversal rejected');
  });
});

// ---------------------------------------------------------------------------
// registerCppTools — all 8 tools registered
// ---------------------------------------------------------------------------

describe('registerCppTools — all 8 tools registered', () => {
  it('19. registerCppTools registers all 8 tool names on McpServer', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

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

  it('20. withKnownIssues catches exceptions from generation handlers and returns isError', async () => {
    const { withKnownIssues } = await import('../src/tools/known-issues/middleware.js');

    const throwingHandler = async (_args: { file_path: string; include_path: string }) => {
      throw new Error('Test generation handler exception');
    };

    const wrapped = withKnownIssues('ue_add_include', throwingHandler);
    const result = await wrapped({
      file_path: '/some/file.h',
      include_path: '"Something.h"',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Test generation handler exception');
  });
});
