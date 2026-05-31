// MCPNetworkingCommands.h
// Declares the registration function for all networking and replication MCP command handlers.
// Handlers: net.replication, net.properties, net.driver, net.session
//
// Call RegisterNetworkingCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all four networking command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 */
void RegisterNetworkingCommands(FMCPCommandRouter& Router);
