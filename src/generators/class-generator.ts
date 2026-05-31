// src/generators/class-generator.ts
// Pure synchronous template-based code generator for UE C++ classes.
//
// Produces valid UE C++ .h/.cpp file pairs for all 8 class types:
//   Actor, ActorComponent, SceneComponent, GameMode, GameState,
//   PlayerState, PlayerController, Interface
//
// Non-negotiable UHT constraints:
//   1. GENERATED_BODY() is the FIRST item inside every class body
//   2. ClassName.generated.h is the LAST #include in every header
//
// Security mitigations (threat model T-05-03, T-05-04):
//   - className validated against ^[A-Za-z_][A-Za-z0-9_]*$ before embedding
//   - moduleName stripped of non-alphanumeric chars before uppercasing
//
// No fs, no async, no side effects — pure functions only.
// No console.log — use console.error only.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClassType =
  | 'Actor'
  | 'ActorComponent'
  | 'SceneComponent'
  | 'GameMode'
  | 'GameState'
  | 'PlayerState'
  | 'PlayerController'
  | 'Interface';

export type GenerateClassOptions = {
  classType: ClassType;
  /** Class name with or without prefix — generator applies the correct prefix */
  className: string;
  /** Module name (e.g. "MyGame") — converted to MYGAME_API */
  moduleName: string;
  /** Optional parent class override (defaults per classType) */
  parentClass?: string;
};

export type GeneratedClass = {
  header: string;
  cpp: string;
  headerFileName: string;
  cppFileName: string;
};

// ---------------------------------------------------------------------------
// Internal config per class type
// ---------------------------------------------------------------------------

type ClassConfig = {
  /** Default parent class */
  defaultParent: string;
  /** Header include for the parent class */
  parentInclude: string;
  /** UE identifier prefix for this type (A or U) */
  prefix: 'A' | 'U';
  /** Whether the type gets Tick / TickComponent in .cpp */
  hasTick: boolean;
  /** Whether the type gets BeginPlay in .cpp */
  hasBeginPlay: boolean;
  /** Use TickComponent signature (for components) instead of Tick */
  useTickComponent: boolean;
  /** True for Interface — special dual-class template */
  isInterface: boolean;
};

const CLASS_CONFIG: Record<ClassType, ClassConfig> = {
  Actor: {
    defaultParent: 'AActor',
    parentInclude: 'GameFramework/Actor.h',
    prefix: 'A',
    hasTick: true,
    hasBeginPlay: true,
    useTickComponent: false,
    isInterface: false,
  },
  ActorComponent: {
    defaultParent: 'UActorComponent',
    parentInclude: 'Components/ActorComponent.h',
    prefix: 'U',
    hasTick: true,
    hasBeginPlay: true,
    useTickComponent: true,
    isInterface: false,
  },
  SceneComponent: {
    defaultParent: 'USceneComponent',
    parentInclude: 'Components/SceneComponent.h',
    prefix: 'U',
    hasTick: true,
    hasBeginPlay: true,
    useTickComponent: true,
    isInterface: false,
  },
  GameMode: {
    defaultParent: 'AGameModeBase',
    parentInclude: 'GameFramework/GameModeBase.h',
    prefix: 'A',
    hasTick: false,
    hasBeginPlay: false,
    useTickComponent: false,
    isInterface: false,
  },
  GameState: {
    defaultParent: 'AGameStateBase',
    parentInclude: 'GameFramework/GameStateBase.h',
    prefix: 'A',
    hasTick: false,
    hasBeginPlay: false,
    useTickComponent: false,
    isInterface: false,
  },
  PlayerState: {
    defaultParent: 'APlayerState',
    parentInclude: 'GameFramework/PlayerState.h',
    prefix: 'A',
    hasTick: false,
    hasBeginPlay: false,
    useTickComponent: false,
    isInterface: false,
  },
  PlayerController: {
    defaultParent: 'APlayerController',
    parentInclude: 'GameFramework/PlayerController.h',
    prefix: 'A',
    hasTick: false,
    hasBeginPlay: false,
    useTickComponent: false,
    isInterface: false,
  },
  Interface: {
    defaultParent: 'UInterface',
    parentInclude: 'UObject/Interface.h',
    prefix: 'U',
    hasTick: false,
    hasBeginPlay: false,
    useTickComponent: false,
    isInterface: true,
  },
};

// ---------------------------------------------------------------------------
// Security helpers (T-05-03, T-05-04)
// ---------------------------------------------------------------------------

/** Valid C++ identifier pattern */
const VALID_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Sanitize a className for safe embedding.
 * If invalid, returns a safe fallback name.
 */
function sanitizeClassName(name: string): { safe: string; wasInvalid: boolean } {
  const trimmed = (name ?? '').trim();
  if (VALID_IDENTIFIER_RE.test(trimmed)) {
    return { safe: trimmed, wasInvalid: false };
  }
  // Strip everything that isn't a valid C++ identifier char
  const stripped = trimmed.replace(/[^A-Za-z0-9_]/g, '');
  const safe = stripped.length > 0 && /^[A-Za-z_]/.test(stripped)
    ? stripped
    : 'UnknownClass';
  if (trimmed !== safe) {
    console.error(`[class-generator] Invalid className "${trimmed}" — using safe fallback "${safe}"`);
  }
  return { safe, wasInvalid: true };
}

/**
 * Build the API macro from moduleName.
 * T-05-04: strips non-alphanumeric chars before uppercasing.
 */
function buildApiMacro(moduleName: string): string {
  const stripped = (moduleName ?? '').replace(/[^a-zA-Z0-9]/g, '');
  return stripped.toUpperCase() + '_API';
}

// ---------------------------------------------------------------------------
// Class name prefix resolution
// ---------------------------------------------------------------------------

/**
 * Apply the correct UE prefix (A or U) to a class name,
 * without double-prefixing if the name already starts with that letter.
 */
function applyPrefix(name: string, prefix: 'A' | 'U'): string {
  if (name.startsWith(prefix)) return name;
  return prefix + name;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function makeActorHeader(
  className: string,
  parentClass: string,
  parentInclude: string,
  apiMacro: string,
  config: ClassConfig,
): string {
  const tickDecl = config.hasTick
    ? '\npublic:\n\tvirtual void Tick(float DeltaTime) override;\n'
    : '';
  const beginPlayDecl = config.hasBeginPlay
    ? '\nprotected:\n\tvirtual void BeginPlay() override;\n'
    : '';

  return `#pragma once

#include "CoreMinimal.h"
#include "${parentInclude}"
#include "${className}.generated.h"

UCLASS(BlueprintType, Blueprintable)
class ${apiMacro} ${className} : public ${parentClass}
{
\tGENERATED_BODY()

public:
\t${className}();
${beginPlayDecl}${tickDecl}};
`;
}

function makeActorCpp(
  className: string,
  config: ClassConfig,
): string {
  const beginPlayImpl = config.hasBeginPlay
    ? `
void ${className}::BeginPlay()
{
\tSuper::BeginPlay();
}
`
    : '';

  const tickImpl = config.hasTick && !config.useTickComponent
    ? `
void ${className}::Tick(float DeltaTime)
{
\tSuper::Tick(DeltaTime);
}
`
    : '';

  const tickComponentImpl = config.hasTick && config.useTickComponent
    ? `
void ${className}::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)
{
\tSuper::TickComponent(DeltaTime, TickType, ThisTickFunction);
}
`
    : '';

  const constructorBody = config.useTickComponent
    ? `\tPrimaryComponentTick.bCanEverTick = true;`
    : `\tPrimaryActorTick.bCanEverTick = true;`;

  return `#include "${className}.h"

${className}::${className}()
{
${constructorBody}
}
${beginPlayImpl}${tickImpl}${tickComponentImpl}`;
}

function makeComponentHeader(
  className: string,
  parentClass: string,
  parentInclude: string,
  apiMacro: string,
  config: ClassConfig,
): string {
  const tickDecl = config.hasTick && config.useTickComponent
    ? '\npublic:\n\tvirtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;\n'
    : '';
  const beginPlayDecl = config.hasBeginPlay
    ? '\nprotected:\n\tvirtual void BeginPlay() override;\n'
    : '';

  return `#pragma once

#include "CoreMinimal.h"
#include "${parentInclude}"
#include "${className}.generated.h"

UCLASS(ClassGroup=(Custom), meta=(BlueprintSpawnableComponent))
class ${apiMacro} ${className} : public ${parentClass}
{
\tGENERATED_BODY()

public:
\t${className}();
${beginPlayDecl}${tickDecl}};
`;
}

function makeSimpleHeader(
  className: string,
  parentClass: string,
  parentInclude: string,
  apiMacro: string,
): string {
  return `#pragma once

#include "CoreMinimal.h"
#include "${parentInclude}"
#include "${className}.generated.h"

UCLASS(BlueprintType, Blueprintable)
class ${apiMacro} ${className} : public ${parentClass}
{
\tGENERATED_BODY()

public:
\t${className}();
};
`;
}

function makeSimpleCpp(className: string): string {
  return `#include "${className}.h"

${className}::${className}()
{
}
`;
}

function makeInterfaceHeader(
  baseName: string,
  parentInclude: string,
  apiMacro: string,
): string {
  // baseName is the stripped name (without U or I prefix)
  // e.g. if className was "MyInterface", baseName = "MyInterface"
  // We need UMyInterface and IMyInterface
  const uName = `U${baseName}`;
  const iName = `I${baseName}`;
  const generatedInclude = `${iName}.generated.h`;

  return `#pragma once

#include "CoreMinimal.h"
#include "${parentInclude}"
#include "${generatedInclude}"

UCLASS(MinimalAPI)
class ${apiMacro} ${uName} : public UInterface
{
\tGENERATED_BODY()
};

class ${apiMacro} ${iName}
{
\tGENERATED_BODY()

public:
\t// Add interface functions here
};
`;
}

function makeInterfaceCpp(baseName: string): string {
  const iName = `I${baseName}`;
  return `#include "${iName}.h"

// Interface implementation stub
// Add default implementations here if needed
`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a UE C++ class file pair (.h + .cpp) for the given class type.
 * Never throws — returns GeneratedClass even for invalid input.
 */
export function generateClass(options: GenerateClassOptions): GeneratedClass {
  try {
    return _generateClass(options);
  } catch (err) {
    console.error('[class-generator] Unexpected error — returning minimal output:', err);
    const fallbackName = 'UnknownClass';
    return {
      header: `#pragma once\n\n// Generation failed\n`,
      cpp: `// Generation failed\n`,
      headerFileName: `${fallbackName}.h`,
      cppFileName: `${fallbackName}.cpp`,
    };
  }
}

function _generateClass(options: GenerateClassOptions): GeneratedClass {
  const { classType, moduleName, parentClass: parentClassOverride } = options;
  const config = CLASS_CONFIG[classType];

  // T-05-04: sanitize moduleName
  const apiMacro = buildApiMacro(moduleName);

  // T-05-03: sanitize className
  const { safe: safeClassName } = sanitizeClassName(options.className);

  // --- Interface: special dual-class pattern ---
  if (config.isInterface) {
    // Strip any existing U/I prefix to get the base name
    let baseName = safeClassName;
    if (baseName.startsWith('U') || baseName.startsWith('I')) {
      // Only strip single-letter prefix if the rest is still a valid name
      const rest = baseName.slice(1);
      if (rest.length > 0) {
        baseName = rest;
      }
    }
    // Canonical file names use I prefix (the "real" interface class)
    const iName = `I${baseName}`;
    const header = makeInterfaceHeader(baseName, config.parentInclude, apiMacro);
    const cpp = makeInterfaceCpp(baseName);
    return {
      header,
      cpp,
      headerFileName: `${iName}.h`,
      cppFileName: `${iName}.cpp`,
    };
  }

  // --- Non-interface classes ---

  // Apply correct prefix (A or U) without double-prefixing
  const fullClassName = applyPrefix(safeClassName, config.prefix);

  // Resolve parent class
  const parentClass = (parentClassOverride && parentClassOverride.trim())
    ? parentClassOverride.trim()
    : config.defaultParent;

  // Build header and cpp based on class family
  let header: string;
  let cpp: string;

  const isComponent = classType === 'ActorComponent' || classType === 'SceneComponent';

  if (isComponent) {
    header = makeComponentHeader(fullClassName, parentClass, config.parentInclude, apiMacro, config);
    cpp = makeActorCpp(fullClassName, config);
  } else if (classType === 'Actor') {
    header = makeActorHeader(fullClassName, parentClass, config.parentInclude, apiMacro, config);
    cpp = makeActorCpp(fullClassName, config);
  } else {
    // GameMode, GameState, PlayerState, PlayerController — no Tick, no BeginPlay
    header = makeSimpleHeader(fullClassName, parentClass, config.parentInclude, apiMacro);
    cpp = makeSimpleCpp(fullClassName);
  }

  return {
    header,
    cpp,
    headerFileName: `${fullClassName}.h`,
    cppFileName: `${fullClassName}.cpp`,
  };
}
