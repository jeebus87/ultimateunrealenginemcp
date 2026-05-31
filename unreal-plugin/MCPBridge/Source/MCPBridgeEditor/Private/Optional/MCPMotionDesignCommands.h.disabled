// MCPMotionDesignCommands.h (Plan 28-01)
// Declares the registration function for all Motion Design MCP command handlers.
// Handlers: motiondesign.sceneStates, motiondesign.transition,
//           motiondesign.transitionLogic, motiondesign.remoteControl
//
// Call RegisterMotionDesignCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all four Motion Design command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   motiondesign.sceneStates    -- list Scene State machines with states and categories (MD-01)
 *   motiondesign.transition     -- trigger Scene State transitions and set property values (MD-02)
 *   motiondesign.transitionLogic -- inspect Transition Logic sequences: in/out labels, layer changes (MD-03)
 *   motiondesign.remoteControl  -- read/modify Remote Control preset properties and trigger events (MD-04)
 *
 * Note: Motion Design (Avalanche) is experimental in UE 5.7. Handlers for
 * motiondesign.sceneStates, motiondesign.transition, and motiondesign.transitionLogic
 * will return "motion_design_plugin_not_enabled" if the AvalancheRundown or
 * AvalancheTransition modules are not loaded in the current project.
 */
void RegisterMotionDesignCommands(FMCPCommandRouter& Router);
