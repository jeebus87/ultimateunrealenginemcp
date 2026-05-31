// MCPSequencerCommands.h
// Declares the registration function for all sequencer-related MCP command handlers.
// Handlers: sequencer.create, sequencer.tracks, sequencer.addTrack, sequencer.addKey, sequencer.playback
//
// Call RegisterSequencerCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all five sequencer command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 */
void RegisterSequencerCommands(FMCPCommandRouter& Router);
