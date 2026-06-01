// MCPWorldPartitionCommands.h (Plan 33-03)
// Declares the registration function for all World Partition MCP command handlers.
// Handlers: worldpartition.settings, worldpartition.dataLayers,
//           worldpartition.streamingSources, worldpartition.hlod
//
// Call RegisterWorldPartitionCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.
//
// Converted from Optional/MCPWorldPartitionCommands.cpp.disabled to reflection-based
// approach (Plan 33-03). DataLayerEditorSubsystem header removed; data layer write
// operations use FindObject<UClass> and UObject::FindFunction/ProcessEvent reflection.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all four World Partition command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   worldpartition.settings        -- read WP grid size, loading range, streaming config (WP-01)
 *   worldpartition.dataLayers      -- list/create/toggle data layers, assign actors (WP-02)
 *   worldpartition.streamingSources -- inspect streaming sources with shape, priority, target state (WP-03)
 *   worldpartition.hlod            -- inspect HLOD layer config and trigger HLOD generation (WP-04)
 */
void RegisterWorldPartitionCommands(FMCPCommandRouter& Router);
