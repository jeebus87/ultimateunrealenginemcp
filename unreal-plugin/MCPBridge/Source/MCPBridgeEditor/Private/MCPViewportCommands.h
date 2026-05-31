// MCPViewportCommands.h
// Declares handler registration for viewport camera, render mode, screenshot, and
// visual review loop commands.
// Handles: viewport.screenshot, viewport.camera, viewport.renderMode,
//          viewport.hiresScreenshot, viewport.lookAt, viewport.frustumActors,
//          viewport.focusActor, viewport.cleanupScreenshots
//
// Call RegisterViewportCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all viewport command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   viewport.screenshot          -- capture active viewport at specified resolution (PIE-05)
 *   viewport.camera              -- set viewport position, rotation, and/or FOV (PIE-06)
 *   viewport.renderMode          -- switch lit/unlit/wireframe/collision/detail_lighting (PIE-07)
 *   viewport.hiresScreenshot     -- capture high-resolution screenshot (PIE-08)
 *   viewport.lookAt              -- resolve actor label and move editor camera to view it (VIS-03)
 *   viewport.frustumActors       -- list actors near camera sorted by distance (VIS-05)
 *   viewport.focusActor          -- auto-frame actor from bounding box with padding (VIS-07)
 *   viewport.cleanupScreenshots  -- delete MCP-generated mcp_screenshot_*.png files (VIS-08)
 */
void RegisterViewportCommands(FMCPCommandRouter& Router);
