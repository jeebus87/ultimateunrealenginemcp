// MCPAudioCommands.h (Plan 23-01)
// Declares the registration function for all audio system inspection MCP command handlers.
// Handlers: audio.list, audio.metasound, audio.soundcue, audio.insights
//
// Call RegisterAudioCommands(*Router) in MCPBridgeSubsystem::Initialize()
// BEFORE the TCP server starts accepting connections.

#pragma once

#include "MCPCommandRouter.h"

/**
 * Register all four audio command handlers into the given router.
 * Must be called on the game thread before connections arrive.
 *
 * Registered commands:
 *   audio.list        -- list sound assets filtered by type (AUD-01)
 *   audio.metasound   -- inspect MetaSound patch graph nodes, inputs, outputs (AUD-02)
 *   audio.soundcue    -- read SoundCue node graph and attenuation settings (AUD-03)
 *   audio.insights    -- query Audio Insights monitoring data with graceful fallback (AUD-04)
 */
void RegisterAudioCommands(FMCPCommandRouter& Router);
