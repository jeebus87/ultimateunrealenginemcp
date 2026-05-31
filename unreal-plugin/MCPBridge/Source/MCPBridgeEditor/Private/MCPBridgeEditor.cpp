// MCPBridgeEditor.cpp
// Editor module startup/shutdown.
// UMCPBridgeSubsystem (UEditorSubsystem) manages TCP server lifecycle
// and is initialized automatically by the subsystem framework after
// PostEngineInit -- do not manually start the TCP server here.

#include "MCPBridgeEditor.h"

#define LOCTEXT_NAMESPACE "FMCPBridgeEditorModule"

void FMCPBridgeEditorModule::StartupModule()
{
    // UMCPBridgeSubsystem::Initialize() handles TCP server startup.
}

void FMCPBridgeEditorModule::ShutdownModule()
{
    // UMCPBridgeSubsystem::Deinitialize() handles TCP server shutdown.
}

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FMCPBridgeEditorModule, MCPBridgeEditor)
