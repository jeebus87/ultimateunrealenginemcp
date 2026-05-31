// tests/uht-validator.test.ts
// TDD test suite for the UHT pre-validation function.
// Implementation target: src/generators/uht-validator.ts
//
// Strategy: Pure unit tests — no file I/O. All inputs are raw .h content strings.
// Tests cover GENERATED_BODY() presence, generated.h include order, duplicate
// UPROPERTY/UFUNCTION names, and UPROPERTY specifier allowlist validation.
// GEN-08: validateUhtRules must be called before any file is written to disk.

import { describe, it, expect } from 'vitest';
import { validateUhtRules } from '../src/generators/uht-validator.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/** A well-formed UCLASS header that should pass all validation rules. */
const VALID_HEADER = `
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

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Stats")
    float Stamina;

    UFUNCTION(BlueprintCallable, Category="Combat")
    void Attack();
};
`.trim();

/** Header missing GENERATED_BODY() in the class body. */
const MISSING_GENERATED_BODY = `
#pragma once

#include "CoreMinimal.h"
#include "MyActor.generated.h"

UCLASS()
class MYGAME_API AMyActor : public AActor
{
public:
    UPROPERTY(EditAnywhere)
    float Health;
};
`.trim();

/** Header where generated.h is the first include, not the last. */
const GENERATED_H_NOT_LAST = `
#pragma once

#include "MyActor.generated.h"
#include "CoreMinimal.h"
#include "GameFramework/Actor.h"

UCLASS()
class MYGAME_API AMyActor : public AActor
{
    GENERATED_BODY()

public:
    UPROPERTY(EditAnywhere)
    float Health;
};
`.trim();

/** Header with two UPROPERTYs sharing the same name "Health". */
const DUPLICATE_UPROPERTY = `
#pragma once

#include "CoreMinimal.h"
#include "MyActor.generated.h"

UCLASS()
class MYGAME_API AMyActor : public AActor
{
    GENERATED_BODY()

public:
    UPROPERTY(EditAnywhere)
    float Health;

    UPROPERTY(BlueprintReadWrite)
    float Health;
};
`.trim();

/** Header with two UFUNCTIONs sharing the same name "Attack". */
const DUPLICATE_UFUNCTION = `
#pragma once

#include "CoreMinimal.h"
#include "MyActor.generated.h"

UCLASS()
class MYGAME_API AMyActor : public AActor
{
    GENERATED_BODY()

public:
    UFUNCTION(BlueprintCallable)
    void Attack();

    UFUNCTION(BlueprintCallable)
    void Attack();
};
`.trim();

/** Header missing GENERATED_BODY AND has duplicate property — multiple errors. */
const MULTIPLE_ERRORS = `
#pragma once

#include "CoreMinimal.h"
#include "MyActor.generated.h"

UCLASS()
class MYGAME_API AMyActor : public AActor
{
public:
    UPROPERTY(EditAnywhere)
    float Health;

    UPROPERTY(BlueprintReadWrite)
    float Health;
};
`.trim();

/** Plain C++ header with no UCLASS macro — not a UE reflection header. */
const PLAIN_STRUCT_HEADER = `
#pragma once
#include "CoreMinimal.h"

struct FMyPlainStruct {
    int X;
    int Y;
};
`.trim();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateUhtRules', () => {

  describe('valid content', () => {
    it('returns { valid: true, errors: [] } for a well-formed UCLASS header', () => {
      const result = validateUhtRules(VALID_HEADER);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns { valid: true, errors: [] } for empty string content', () => {
      const result = validateUhtRules('');
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns { valid: true, errors: [] } for content with no UCLASS', () => {
      const result = validateUhtRules(PLAIN_STRUCT_HEADER);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('GENERATED_BODY() check', () => {
    it('returns { valid: false } when GENERATED_BODY() is missing from class body', () => {
      const result = validateUhtRules(MISSING_GENERATED_BODY);
      expect(result.valid).toBe(false);
    });

    it('returns error message mentioning the class name when GENERATED_BODY() is missing', () => {
      const result = validateUhtRules(MISSING_GENERATED_BODY);
      expect(result.errors.length).toBeGreaterThan(0);
      const error = result.errors.find(e => e.includes('GENERATED_BODY()'));
      expect(error).toBeDefined();
      expect(error).toContain('AMyActor');
      expect(error).toContain('GENERATED_BODY()');
    });
  });

  describe('generated.h last-include check', () => {
    it('returns { valid: false } when generated.h is not the last include', () => {
      const result = validateUhtRules(GENERATED_H_NOT_LAST);
      expect(result.valid).toBe(false);
    });

    it('returns error message mentioning the generated.h filename and "last"', () => {
      const result = validateUhtRules(GENERATED_H_NOT_LAST);
      expect(result.errors.length).toBeGreaterThan(0);
      const error = result.errors.find(e => e.includes('generated.h'));
      expect(error).toBeDefined();
      expect(error).toContain('generated.h');
      expect(error).toContain('last');
    });
  });

  describe('duplicate UPROPERTY name check', () => {
    it('returns { valid: false } when two UPROPERTYs have the same name', () => {
      const result = validateUhtRules(DUPLICATE_UPROPERTY);
      expect(result.valid).toBe(false);
    });

    it('returns error message mentioning "duplicate" and the duplicate property name', () => {
      const result = validateUhtRules(DUPLICATE_UPROPERTY);
      expect(result.errors.length).toBeGreaterThan(0);
      const error = result.errors.find(e => e.includes('duplicate') && e.includes('Health'));
      expect(error).toBeDefined();
    });
  });

  describe('duplicate UFUNCTION name check', () => {
    it('returns { valid: false } when two UFUNCTIONs have the same name', () => {
      const result = validateUhtRules(DUPLICATE_UFUNCTION);
      expect(result.valid).toBe(false);
    });
  });

  describe('multi-error collection', () => {
    it('collects multiple errors — does not short-circuit on first error', () => {
      // MULTIPLE_ERRORS has: missing GENERATED_BODY + duplicate UPROPERTY name
      const result = validateUhtRules(MULTIPLE_ERRORS);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('never-throw guarantee', () => {
    it('never throws — returns error result for malformed input (null cast as string)', () => {
      // Cast null as string to simulate caller passing wrong type
      let threw = false;
      let result: ReturnType<typeof validateUhtRules> | null = null;
      try {
        result = validateUhtRules(null as unknown as string);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      // Must return an object with valid and errors properties
      expect(result).not.toBeNull();
      expect(typeof result!.valid).toBe('boolean');
      expect(Array.isArray(result!.errors)).toBe(true);
    });
  });

});
