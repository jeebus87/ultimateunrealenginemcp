// MCPGASCommands.h (Plan 33-04)
// Declares the registration function for all Gameplay Ability System MCP command handlers.
// Handlers: gas.abilities, gas.effects, gas.attributes, gas.tags
//
// Call RegisterGASCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.
//
// All handlers compile without optional plugin headers.
// gas.abilities, gas.effects, gas.attributes use runtime reflection to locate
// GameplayAbilities types and return "module_not_available" when the
// GameplayAbilities module is not loaded.
// gas.tags uses the core GameplayTags module (always available).

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all four GAS command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   gas.abilities    -- list all Gameplay Ability classes with tags, costs, and cooldowns (GAS-01)
 *   gas.effects      -- inspect Gameplay Effect modifiers, duration policy, stacking, period (GAS-02)
 *   gas.attributes   -- read Attribute Set definitions with base values and clamping info (GAS-03)
 *   gas.tags         -- query Gameplay Tag hierarchy and find assets using specific tags (GAS-04)
 */
void RegisterGASCommands(FMCPCommandRouter& Router);
