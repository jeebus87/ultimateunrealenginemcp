// MCPLiveLinkCommands.h (Plan 33-02)
// Declares the registration function for all Live Link MCP command handlers.
// Handlers: livelink.sources, livelink.subjects, livelink.control, livelink.preview
//
// Call RegisterLiveLinkCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all four Live Link command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   livelink.sources   -- list all active Live Link sources with type, machine name, status (LL-01)
 *   livelink.subjects  -- list all Live Link subjects with roles and enabled state (LL-02)
 *   livelink.control   -- pause/resume individual Live Link subjects by toggling enabled state (LL-03)
 *   livelink.preview   -- inspect current frame data for any Live Link subject (LL-04)
 */
void RegisterLiveLinkCommands(FMCPCommandRouter& Router);
