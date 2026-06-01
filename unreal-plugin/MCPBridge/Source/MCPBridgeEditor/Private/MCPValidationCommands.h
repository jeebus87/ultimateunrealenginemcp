// MCPValidationCommands.h
// Declares handler registration for asset validation and Blueprint compile-check commands.
// Handles: validate.asset, validate.folder, validate.project, validate.blueprint
//
// Call RegisterValidationCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all validation command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   validate.asset      -- run UEditorValidatorSubsystem on a single asset path (VAL-01)
 *   validate.folder     -- run validation on all assets under a folder path (VAL-02)
 *   validate.project    -- run validation across the full /Game/ tree (VAL-03)
 *   validate.blueprint  -- compile a Blueprint and return compiler messages (VAL-04)
 *
 * validate.asset, validate.folder, and validate.project require the DataValidation
 * module to be loaded (enabled in the user's project). When not available, they
 * return { "error": "datavalidation_not_available" }.
 */
void RegisterValidationCommands(FMCPCommandRouter& Router);
