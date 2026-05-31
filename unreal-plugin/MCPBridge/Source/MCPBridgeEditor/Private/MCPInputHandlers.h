// MCPInputHandlers.h
// Declares the Enhanced Input command handler registration function.
// Call RegisterInputHandlers() from UMCPBridgeSubsystem::Initialize()
// after the router is created.
//
// Handlers: input.listActions, input.createAction, input.listContexts,
//           input.addBinding
//
// IMPORTANT: Every write handler calls Object->Modify() before any mutation
// and saves the package after -- never skip these.

#pragma once

#include "CoreMinimal.h"

class FMCPCommandRouter;

/**
 * Register input.listActions, input.createAction, input.listContexts,
 * and input.addBinding handlers on the given router.
 * All handlers run on the game thread (enforced by FMCPCommandRouter::Dispatch
 * via AsyncTask).
 */
void RegisterInputHandlers(FMCPCommandRouter& Router);
