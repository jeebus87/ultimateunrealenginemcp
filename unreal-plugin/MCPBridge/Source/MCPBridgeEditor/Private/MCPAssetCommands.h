// MCPAssetCommands.h
// Declares the registration function for asset registry and level layout MCP command handlers.
// Handlers: asset.query, asset.references, level.layout
//
// Call RegisterAssetCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all three asset/level command handlers into the given router.
 * Handlers: asset.query (EDT-05), asset.references (EDT-06), level.layout (EDT-07).
 * Must be called on the game thread before connections arrive.
 */
void RegisterAssetCommands(FMCPCommandRouter& Router);
