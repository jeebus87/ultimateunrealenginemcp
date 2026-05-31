// tests/file-modifier.test.ts
// TDD test suite for addProperty, addFunction, addInclude — Plan 05-03
// GEN-05, GEN-06, GEN-07, GEN-08

import { describe, it, expect } from 'vitest';
import { addProperty, addFunction, addInclude } from '../src/generators/file-modifier.js';

// ---------------------------------------------------------------------------
// Fixtures
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

const EMPTY_CLASS_HEADER = `#pragma once

#include "CoreMinimal.h"
#include "AEmpty.generated.h"

UCLASS()
class AEmpty : public AActor
{
\tGENERATED_BODY()
};
`;

const NO_GENERATED_HEADER = `#pragma once

#include "CoreMinimal.h"
#include "SomeOtherInclude.h"

// No UCLASS in this file — just includes
`;

// ---------------------------------------------------------------------------
// addProperty tests — GEN-05
// ---------------------------------------------------------------------------

describe('addProperty — GEN-05', () => {
  it('returns { success: true } and content contains the new UPROPERTY block', () => {
    const decl = { specifiers: ['EditAnywhere'], type: 'int32', name: 'Score' };
    const result = addProperty(BASE_ACTOR_HEADER, 'AMyActor', decl);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.content).toContain('UPROPERTY(EditAnywhere)');
    expect(result.content).toContain('int32 Score');
  });

  it('inserts after the last existing UPROPERTY in class body', () => {
    const decl = { specifiers: ['EditAnywhere'], type: 'int32', name: 'Score' };
    const result = addProperty(BASE_ACTOR_HEADER, 'AMyActor', decl);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const healthIdx = result.content.indexOf('float Health');
    const scoreIdx = result.content.indexOf('int32 Score');
    expect(scoreIdx).toBeGreaterThan(healthIdx);
  });

  it('returns { success: false } when className is not found in file', () => {
    const decl = { specifiers: ['EditAnywhere'], type: 'int32', name: 'Score' };
    const result = addProperty(BASE_ACTOR_HEADER, 'ANotHere', decl);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('ANotHere');
  });

  it('works for empty class (no existing properties) — inserts after GENERATED_BODY()', () => {
    const decl = { specifiers: ['EditAnywhere'], type: 'float', name: 'Speed' };
    const result = addProperty(EMPTY_CLASS_HEADER, 'AEmpty', decl);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.content).toContain('UPROPERTY(EditAnywhere)');
    expect(result.content).toContain('float Speed');

    // Inserted after GENERATED_BODY()
    const genBodyIdx = result.content.indexOf('GENERATED_BODY()');
    const speedIdx = result.content.indexOf('float Speed');
    expect(speedIdx).toBeGreaterThan(genBodyIdx);
  });

  it('result still has generated.h as last include (UHT rule preserved)', () => {
    const decl = { specifiers: ['EditAnywhere'], type: 'int32', name: 'Score' };
    const result = addProperty(BASE_ACTOR_HEADER, 'AMyActor', decl);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const lines = result.content.split('\n');
    const includeLines = lines.filter((l) => l.trim().startsWith('#include'));
    const lastInclude = includeLines[includeLines.length - 1] ?? '';
    expect(lastInclude).toContain('.generated.h');
  });
});

// ---------------------------------------------------------------------------
// addFunction tests — GEN-06
// ---------------------------------------------------------------------------

describe('addFunction — GEN-06', () => {
  it('returns { success: true } and content contains the new UFUNCTION block', () => {
    const decl = {
      specifiers: ['BlueprintCallable'],
      returnType: 'void',
      name: 'Heal',
      params: 'float Amount',
    };
    const result = addFunction(BASE_ACTOR_HEADER, 'AMyActor', decl);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.content).toContain('UFUNCTION(BlueprintCallable)');
    expect(result.content).toContain('void Heal(float Amount)');
  });

  it('inserts after the last existing UFUNCTION in class body', () => {
    const decl = {
      specifiers: ['BlueprintCallable'],
      returnType: 'void',
      name: 'Heal',
      params: 'float Amount',
    };
    const result = addFunction(BASE_ACTOR_HEADER, 'AMyActor', decl);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const attackIdx = result.content.indexOf('void Attack()');
    const healIdx = result.content.indexOf('void Heal(float Amount)');
    expect(healIdx).toBeGreaterThan(attackIdx);
  });

  it('returns { success: false } when className not found', () => {
    const decl = {
      specifiers: ['BlueprintCallable'],
      returnType: 'void',
      name: 'Heal',
    };
    const result = addFunction(BASE_ACTOR_HEADER, 'ANotHere', decl);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('ANotHere');
  });

  it('handles const function correctly (isConst: true adds " const" to declaration)', () => {
    const decl = {
      specifiers: ['BlueprintPure'],
      returnType: 'float',
      name: 'GetHealth',
      params: '',
      isConst: true,
    };
    const result = addFunction(BASE_ACTOR_HEADER, 'AMyActor', decl);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.content).toContain('float GetHealth() const;');
  });

  it('works for empty class — inserts after GENERATED_BODY()', () => {
    const decl = { specifiers: [], returnType: 'void', name: 'Init' };
    const result = addFunction(EMPTY_CLASS_HEADER, 'AEmpty', decl);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.content).toContain('void Init()');

    // Inserted after GENERATED_BODY()
    const genBodyIdx = result.content.indexOf('GENERATED_BODY()');
    const initIdx = result.content.indexOf('void Init()');
    expect(initIdx).toBeGreaterThan(genBodyIdx);
  });
});

// ---------------------------------------------------------------------------
// addInclude tests — GEN-07
// ---------------------------------------------------------------------------

describe('addInclude — GEN-07', () => {
  it('returns { success: true } and content contains the new include', () => {
    const result = addInclude(BASE_ACTOR_HEADER, '"Engine/StaticMeshActor.h"');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.content).toContain('#include "Engine/StaticMeshActor.h"');
  });

  it('inserts new include BEFORE .generated.h line', () => {
    const result = addInclude(BASE_ACTOR_HEADER, '"Engine/StaticMeshActor.h"');

    expect(result.success).toBe(true);
    if (!result.success) return;

    const newIncludeIdx = result.content.indexOf('#include "Engine/StaticMeshActor.h"');
    const generatedIdx = result.content.indexOf('AMyActor.generated.h');
    expect(newIncludeIdx).toBeLessThan(generatedIdx);
  });

  it('is idempotent — does not insert duplicate if include already exists', () => {
    const result = addInclude(BASE_ACTOR_HEADER, '"CoreMinimal.h"');

    expect(result.success).toBe(true);
    if (!result.success) return;

    const originalCount = (BASE_ACTOR_HEADER.match(/#include/g) ?? []).length;
    const resultCount = (result.content.match(/#include/g) ?? []).length;
    expect(resultCount).toBe(originalCount);
  });

  it('works with angle-bracket includes', () => {
    const result = addInclude(BASE_ACTOR_HEADER, '<algorithm>');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.content).toContain('#include <algorithm>');
  });

  it('inserts after last #include when no .generated.h present', () => {
    const result = addInclude(NO_GENERATED_HEADER, '"MyExtra.h"');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.content).toContain('#include "MyExtra.h"');
  });
});
