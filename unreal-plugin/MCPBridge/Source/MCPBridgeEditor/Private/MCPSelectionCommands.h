// MCPSelectionCommands.h (Plan 19-01)
// Declares the registration function for all actor selection MCP command handlers.
// Handlers: selection.select, selection.get, selection.duplicate, selection.convert
//
// Call RegisterSelectionCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all four selection command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   selection.select    -- select/deselect actors by name, label, or class filter (SEL-01)
 *   selection.get       -- get current selection or apply all/none/invert bulk operation (SEL-02)
 *   selection.duplicate -- duplicate selected actors with optional position offset (SEL-03)
 *   selection.convert   -- convert an actor to a different target class (SEL-04)
 */
void RegisterSelectionCommands(FMCPCommandRouter& Router);
