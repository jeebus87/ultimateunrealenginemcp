// MCPCollisionPhysicsCommands.h (Plan 20-01)
// Declares handler registration for collision configuration and physics inspection commands.
// Handles: collision.read, collision.set, physics.material, physics.asset
//
// Call RegisterCollisionPhysicsCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all collision and physics command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   collision.read    -- read collision preset, enabled state, object type, and per-channel response map for a component (PHY-01)
 *   collision.set     -- apply collision preset or individual channel overrides to a component (PHY-02)
 *   physics.material  -- read and set friction, restitution, density, and surface type on a UPhysicalMaterial (PHY-03)
 *   physics.asset     -- return per-bone body setup with primitive shapes (capsules, spheres, boxes) and dimensions (PHY-04)
 */
void RegisterCollisionPhysicsCommands(FMCPCommandRouter& Router);
