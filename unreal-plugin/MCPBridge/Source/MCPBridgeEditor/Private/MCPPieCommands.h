// MCPPieCommands.h
// Declares handler registration for PIE (Play In Editor) control.
// Handles: pie.start, pie.stop, pie.logs, pie.gameState
//
// Call RegisterPieCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all four PIE command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 */
void RegisterPieCommands(FMCPCommandRouter& Router);
