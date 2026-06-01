// MCPActorCommands.h
// Declares the registration function for all actor-related MCP command handlers.
// Handlers: actor.list, actor.spawn, actor.transform, actor.delete, actor.setProperty
//
// Call RegisterActorCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all actor command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 */
void RegisterActorCommands(FMCPCommandRouter& Router);
