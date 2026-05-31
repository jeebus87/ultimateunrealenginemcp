// MCPBlueprintWriteHandlers.h
// Declares the Blueprint write command handler registration function.
// Call RegisterBlueprintWriteHandlers() from UMCPBridgeSubsystem::Initialize()
// after the router is created.
//
// Handlers: blueprint.create, blueprint.addNode, blueprint.connectPins,
//           blueprint.addVariable, blueprint.setDefault
//
// IMPORTANT: Every handler calls Object->Modify() before any mutation and
// FBlueprintEditorUtils::MarkBlueprintAsModified() after -- never skip these.

#pragma once

#include "CoreMinimal.h"

class FMCPCommandRouter;

/**
 * Register blueprint.create, blueprint.addNode, blueprint.connectPins,
 * blueprint.addVariable, and blueprint.setDefault handlers on the given router.
 * All handlers run on the game thread (enforced by FMCPCommandRouter::Dispatch
 * via AsyncTask).
 */
void RegisterBlueprintWriteHandlers(FMCPCommandRouter& Router);
