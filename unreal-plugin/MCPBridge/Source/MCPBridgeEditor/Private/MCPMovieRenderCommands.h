// MCPMovieRenderCommands.h
// Declares the registration function for all Movie Render Pipeline MCP command handlers.
// Handlers: movierender.queue, movierender.addJob, movierender.control, movierender.configure
//
// Call RegisterMovieRenderCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all four Movie Render Pipeline command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 */
void RegisterMovieRenderCommands(FMCPCommandRouter& Router);
