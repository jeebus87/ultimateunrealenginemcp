// MCPChaosCommands.h (Plan 26-01)
// Declares the registration function for all Chaos physics MCP command handlers.
// Handlers: chaos.geometryCollection, chaos.resetDestruction, chaos.cloth, chaos.physicsCache
//
// Call RegisterChaosCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all four Chaos physics command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   chaos.geometryCollection -- inspect geometry collection fracture hierarchy and cluster config (CHAOS-01)
 *   chaos.resetDestruction   -- reset destruction state on a geometry collection actor (CHAOS-02)
 *   chaos.cloth              -- read cloth simulation parameters (stiffness, damping, etc.) (CHAOS-03)
 *   chaos.physicsCache       -- manage physics cache recording: start, stop, query (CHAOS-04)
 */
void RegisterChaosCommands(FMCPCommandRouter& Router);
