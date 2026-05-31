// tests/class-generator.test.ts
// TDD test suite for generateClass — RED phase.
// All 8 UE class types + UHT constraints + security validation.
//
// Test coverage:
//   GEN-01: Actor class generation
//   GEN-02: Component class generation (ActorComponent, SceneComponent)
//   GEN-03: GameMode, GameState, PlayerState, PlayerController
//   GEN-04: Interface dual-class generation
//   Non-negotiable UHT constraints: GENERATED_BODY() first, .generated.h last

import { describe, it, expect } from 'vitest';
import { generateClass } from '../src/generators/class-generator.js';

// ---------------------------------------------------------------------------
// Actor class generation — GEN-01
// ---------------------------------------------------------------------------

describe('Actor class generation — GEN-01', () => {
  it('returns GeneratedClass with header and cpp strings', () => {
    const result = generateClass({
      classType: 'Actor',
      className: 'MyActor',
      moduleName: 'MyGame',
    });
    expect(result).toHaveProperty('header');
    expect(result).toHaveProperty('cpp');
    expect(result).toHaveProperty('headerFileName');
    expect(result).toHaveProperty('cppFileName');
    expect(typeof result.header).toBe('string');
    expect(typeof result.cpp).toBe('string');
    expect(result.headerFileName).toBe('AMyActor.h');
    expect(result.cppFileName).toBe('AMyActor.cpp');
  });

  it('header contains UCLASS(), GENERATED_BODY(), AActor parent', () => {
    const result = generateClass({
      classType: 'Actor',
      className: 'MyActor',
      moduleName: 'MyGame',
    });
    expect(result.header).toContain('UCLASS(');
    expect(result.header).toContain('GENERATED_BODY()');
    expect(result.header).toContain('AActor');
    expect(result.header).toContain('AMyActor');
    expect(result.header).toContain('MYGAME_API');
  });

  it('header has AMyActor.generated.h as the last include', () => {
    const result = generateClass({
      classType: 'Actor',
      className: 'MyActor',
      moduleName: 'MyGame',
    });
    const lines = result.header.split('\n');
    const includeLines = lines.filter(l => l.trim().startsWith('#include'));
    expect(includeLines.length).toBeGreaterThan(0);
    const lastInclude = includeLines[includeLines.length - 1];
    expect(lastInclude).toContain('AMyActor.generated.h');
  });

  it('header contains #pragma once as first non-empty line', () => {
    const result = generateClass({
      classType: 'Actor',
      className: 'MyActor',
      moduleName: 'MyGame',
    });
    const lines = result.header.split('\n').filter(l => l.trim().length > 0);
    expect(lines[0].trim()).toBe('#pragma once');
  });

  it('cpp contains constructor, BeginPlay, and Tick overrides', () => {
    const result = generateClass({
      classType: 'Actor',
      className: 'MyActor',
      moduleName: 'MyGame',
    });
    expect(result.cpp).toContain('AMyActor::AMyActor()');
    expect(result.cpp).toContain('BeginPlay');
    expect(result.cpp).toContain('Tick');
  });

  it('cpp calls Super() in constructor', () => {
    const result = generateClass({
      classType: 'Actor',
      className: 'MyActor',
      moduleName: 'MyGame',
    });
    expect(result.cpp).toContain('Super');
  });
});

// ---------------------------------------------------------------------------
// Component class generation — GEN-02
// ---------------------------------------------------------------------------

describe('Component class generation — GEN-02', () => {
  it('ActorComponent header extends UActorComponent', () => {
    const result = generateClass({
      classType: 'ActorComponent',
      className: 'MyComponent',
      moduleName: 'MyGame',
    });
    expect(result.header).toContain('UActorComponent');
    expect(result.header).toContain('UMyComponent');
    expect(result.header).toContain('GENERATED_BODY()');
    expect(result.headerFileName).toBe('UMyComponent.h');
  });

  it('SceneComponent header extends USceneComponent', () => {
    const result = generateClass({
      classType: 'SceneComponent',
      className: 'MySceneComp',
      moduleName: 'MyGame',
    });
    expect(result.header).toContain('USceneComponent');
    expect(result.header).toContain('UMySceneComp');
    expect(result.header).toContain('GENERATED_BODY()');
    expect(result.headerFileName).toBe('UMySceneComp.h');
  });

  it('component header contains GENERATED_BODY()', () => {
    const result = generateClass({
      classType: 'ActorComponent',
      className: 'MyHealthComp',
      moduleName: 'MyGame',
    });
    expect(result.header).toContain('GENERATED_BODY()');
    // GENERATED_BODY() must appear right after the opening brace of the class
    const classBodyStart = result.header.indexOf('{');
    const generatedBodyPos = result.header.indexOf('GENERATED_BODY()');
    expect(classBodyStart).toBeGreaterThan(-1);
    expect(generatedBodyPos).toBeGreaterThan(classBodyStart);
    // Nothing between { and GENERATED_BODY() except whitespace/newlines
    const between = result.header.substring(classBodyStart + 1, generatedBodyPos);
    expect(between.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// GameMode / State / Controller generation — GEN-03
// ---------------------------------------------------------------------------

describe('GameMode/State/Controller generation — GEN-03', () => {
  it('GameMode extends AGameModeBase', () => {
    const result = generateClass({
      classType: 'GameMode',
      className: 'MyGameMode',
      moduleName: 'MyGame',
    });
    expect(result.header).toContain('AGameModeBase');
    expect(result.header).toContain('AMyGameMode');
    expect(result.header).toContain('UCLASS(');
    expect(result.header).toContain('GENERATED_BODY()');
    expect(result.headerFileName).toBe('AMyGameMode.h');
  });

  it('GameState extends AGameStateBase', () => {
    const result = generateClass({
      classType: 'GameState',
      className: 'MyGameState',
      moduleName: 'MyGame',
    });
    expect(result.header).toContain('AGameStateBase');
    expect(result.header).toContain('AMyGameState');
    expect(result.header).toContain('GENERATED_BODY()');
    expect(result.headerFileName).toBe('AMyGameState.h');
  });

  it('PlayerState extends APlayerState', () => {
    const result = generateClass({
      classType: 'PlayerState',
      className: 'MyPlayerState',
      moduleName: 'MyGame',
    });
    expect(result.header).toContain('APlayerState');
    expect(result.header).toContain('AMyPlayerState');
    expect(result.header).toContain('GENERATED_BODY()');
    expect(result.headerFileName).toBe('AMyPlayerState.h');
  });

  it('PlayerController extends APlayerController', () => {
    const result = generateClass({
      classType: 'PlayerController',
      className: 'MyPC',
      moduleName: 'MyGame',
    });
    expect(result.header).toContain('APlayerController');
    expect(result.header).toContain('AMyPC');
    expect(result.header).toContain('GENERATED_BODY()');
    expect(result.headerFileName).toBe('AMyPC.h');
  });
});

// ---------------------------------------------------------------------------
// Interface class generation — GEN-04
// ---------------------------------------------------------------------------

describe('Interface class generation — GEN-04', () => {
  it('Interface header contains both UMyInterface UINTERFACE class and IMyInterface class', () => {
    const result = generateClass({
      classType: 'Interface',
      className: 'MyInterface',
      moduleName: 'MyGame',
    });
    // Must have the UINTERFACE wrapper class
    expect(result.header).toContain('UCLASS(MinimalAPI)');
    expect(result.header).toContain('UMyInterface');
    expect(result.header).toContain('UInterface');
    // Must have the actual interface class with I prefix
    expect(result.header).toContain('IMyInterface');
    // Both GENERATED_BODY() calls
    const generatedBodyCount = (result.header.match(/GENERATED_BODY\(\)/g) || []).length;
    expect(generatedBodyCount).toBeGreaterThanOrEqual(2);
  });

  it('Interface header has generated.h as the last include', () => {
    const result = generateClass({
      classType: 'Interface',
      className: 'MyInterface',
      moduleName: 'MyGame',
    });
    const lines = result.header.split('\n');
    const includeLines = lines.filter(l => l.trim().startsWith('#include'));
    expect(includeLines.length).toBeGreaterThan(0);
    const lastInclude = includeLines[includeLines.length - 1];
    expect(lastInclude).toContain('.generated.h');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting constraints
// ---------------------------------------------------------------------------

describe('Cross-cutting UHT constraints', () => {
  it('respects parentClass override option', () => {
    const result = generateClass({
      classType: 'Actor',
      className: 'MyPawn',
      moduleName: 'MyGame',
      parentClass: 'APawn',
    });
    expect(result.header).toContain('APawn');
    // Should not contain the default parent AActor
    expect(result.header).not.toContain(': public AActor');
  });

  it('API macro uses uppercased module name (MYGAME_API for MyGame module)', () => {
    const result = generateClass({
      classType: 'Actor',
      className: 'MyActor',
      moduleName: 'MyGame',
    });
    expect(result.header).toContain('MYGAME_API');
    // Lowercase should not appear in the API macro context
    expect(result.header).not.toMatch(/mygame_api/i.source === 'mygame_api' ? /mygame_api/ : /MYGAME_API/);
  });

  it('does not double-prefix className that already starts with A prefix', () => {
    const result = generateClass({
      classType: 'Actor',
      className: 'AMyActor', // already has A prefix
      moduleName: 'MyGame',
    });
    // Should NOT produce AAMyActor
    expect(result.header).not.toContain('AAMyActor');
    expect(result.header).toContain('AMyActor');
    expect(result.headerFileName).toBe('AMyActor.h');
  });

  it('never throws — returns GeneratedClass even with minimal/empty input', () => {
    expect(() => generateClass({ classType: 'Actor', className: '', moduleName: '' })).not.toThrow();
    expect(() => generateClass({ classType: 'GameMode', className: 'X', moduleName: 'M' })).not.toThrow();
  });

  it('API macro strips non-alphanumeric chars from moduleName', () => {
    const result = generateClass({
      classType: 'Actor',
      className: 'MyActor',
      moduleName: 'My-Game.Module',
    });
    // Should strip hyphens and dots → MYGAMEMODULE_API
    expect(result.header).toContain('MYGAMEMODULE_API');
  });

  it('validates className — rejects names with injection characters', () => {
    // className must match ^[A-Za-z_][A-Za-z0-9_]* (T-05-03 mitigation)
    // Should return a result with an error indicator, not throw
    const result = generateClass({
      classType: 'Actor',
      className: 'My Actor; rm -rf /',
      moduleName: 'MyGame',
    });
    // Must not throw, must return GeneratedClass
    expect(result).toHaveProperty('header');
    expect(result).toHaveProperty('cpp');
    // The injected content must not appear verbatim in output
    expect(result.header).not.toContain('rm -rf');
    expect(result.cpp).not.toContain('rm -rf');
  });
});
