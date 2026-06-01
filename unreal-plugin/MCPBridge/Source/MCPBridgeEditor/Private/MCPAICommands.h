// MCPAICommands.h (Plan 33-04)
// Declares the registration function for all AI system inspection MCP command handlers.
// Handlers: ai.behaviorTree, ai.stateTree, ai.blackboard, ai.eqs, ai.navmesh
//
// Call RegisterAICommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.
//
// All handlers compile without optional plugin headers.
// ai.behaviorTree, ai.blackboard, ai.eqs, ai.navmesh use direct includes
// from the core AIModule and NavigationSystem modules (in Build.cs).
// ai.stateTree uses runtime reflection to locate StateTree types and returns
// "module_not_available" when the StateTreeModule is not loaded.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all five AI system command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   ai.behaviorTree  -- inspect Behavior Tree node hierarchy, decorators, services (AI-01)
 *   ai.stateTree     -- read State Tree states, transitions, and tasks (AI-02)
 *   ai.blackboard    -- list Blackboard keys with types and default values (AI-03)
 *   ai.eqs           -- inspect EQS query templates: generators, tests, scoring (AI-04)
 *   ai.navmesh       -- query NavMesh build status, bounds, point reachability (AI-05)
 */
void RegisterAICommands(FMCPCommandRouter& Router);
