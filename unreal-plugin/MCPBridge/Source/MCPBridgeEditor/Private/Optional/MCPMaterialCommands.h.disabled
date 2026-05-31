// MCPMaterialCommands.h
// Declares handler registration for material inspection and modification commands.
// Handles: material.params, material.createInstance, material.setParam, material.actorMaterials
//
// Call RegisterMaterialCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all material command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   material.params          -- list scalar/vector/texture parameters of a UMaterialInterface (MAT-01)
 *   material.createInstance  -- create a UMaterialInstanceConstant asset from a parent material (MAT-02)
 *   material.setParam        -- apply a scalar, vector, or texture override to a MIC (MAT-03)
 *   material.actorMaterials  -- list all material asset paths used by an actor or static mesh (MAT-04)
 */
void RegisterMaterialCommands(FMCPCommandRouter& Router);
