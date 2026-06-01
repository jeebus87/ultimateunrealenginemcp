// MCPAnimationCommands.h (Plan 33-03)
// Declares the registration function for all animation asset inspection MCP command handlers.
// Handlers: animation.list, animation.inspectAnimBP, animation.inspectMontage,
//           animation.inspectBlendSpace, animation.retargetMappings
//
// Call RegisterAnimationCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.
//
// Converted from Optional/MCPAnimationCommands.cpp.disabled to reflection-based approach
// (Plan 33-03). IKRig headers removed; retarget handler uses FindObject<UClass> reflection.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all five animation command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   animation.list             -- list animation assets filtered by type (ANIM-01)
 *   animation.inspectAnimBP    -- inspect AnimBlueprint state machines, states, transitions (ANIM-02)
 *   animation.inspectMontage   -- read montage sections, notifies, slot assignments (ANIM-03)
 *   animation.inspectBlendSpace -- inspect blend space axes, sample points, grid config (ANIM-04)
 *   animation.retargetMappings  -- read IK retarget source/target skeleton mappings (ANIM-05)
 */
void RegisterAnimationCommands(FMCPCommandRouter& Router);
