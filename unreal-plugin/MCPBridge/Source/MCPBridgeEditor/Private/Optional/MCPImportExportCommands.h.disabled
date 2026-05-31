// MCPImportExportCommands.h (Plan 21-01)
// Declares the registration function for all asset import/export MCP command handlers.
// Handlers: import.fbx, import.usd, export.mesh, import.batch
//
// Call RegisterImportExportCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all four import/export command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   import.fbx    -- import an FBX file to a content path (IMP-01)
 *   import.usd    -- import a USD file via Interchange pipeline (IMP-02)
 *   export.mesh   -- export a StaticMesh or SkeletalMesh to FBX on disk (IMP-03)
 *   import.batch  -- batch import multiple files from a directory (IMP-04)
 */
void RegisterImportExportCommands(FMCPCommandRouter& Router);
