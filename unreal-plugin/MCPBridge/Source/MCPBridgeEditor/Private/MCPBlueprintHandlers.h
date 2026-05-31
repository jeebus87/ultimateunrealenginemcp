// MCPBlueprintHandlers.h
// Declares the Blueprint command handler registration functions.
// Call RegisterBlueprintHandlers() and RegisterBlueprintBridgeHandlers()
// from UMCPBridgeSubsystem::Initialize() after the router is created.

#pragma once

#include "CoreMinimal.h"

class FMCPCommandRouter;

/**
 * Register blueprint.read, blueprint.graph, and blueprint.list handlers
 * on the given router. All handlers run on the game thread (enforced by
 * FMCPCommandRouter::Dispatch via AsyncTask).
 */
void RegisterBlueprintHandlers(FMCPCommandRouter& Router);

/**
 * Register Blueprint-C++ bridge handlers on the given router:
 *   blueprint.subclasses  -- find all Blueprint assets that inherit from a given C++ class
 *   blueprint.cppUsage    -- scan Blueprint graphs for nodes referencing a specific C++ member
 * All handlers run on the game thread (enforced by FMCPCommandRouter::Dispatch via AsyncTask).
 */
void RegisterBlueprintBridgeHandlers(FMCPCommandRouter& Router);
