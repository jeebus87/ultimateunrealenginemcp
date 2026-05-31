// MCPEditorStateCommands.h
// Declares handler registration for editor state inspection.
// Handles: editor.state
//
// Call RegisterEditorStateCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register the editor.state command handler into the given router.
 * Must be called on the game thread before connections arrive.
 */
void RegisterEditorStateCommands(FMCPCommandRouter& Router);
