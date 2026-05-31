// MCPBridgeRuntime.cpp
// Startup/shutdown for the Runtime module.
// TCP server lifecycle is managed by MCPBridgeSubsystem (Editor module).

#include "MCPBridgeRuntime.h"

#define LOCTEXT_NAMESPACE "FMCPBridgeRuntimeModule"

void FMCPBridgeRuntimeModule::StartupModule()
{
    // TCP server is started by UMCPBridgeSubsystem::Initialize() in the Editor module.
    // This module only provides the TCP server class -- it does not start it here.
}

void FMCPBridgeRuntimeModule::ShutdownModule()
{
    // TCP server is stopped by UMCPBridgeSubsystem::Deinitialize().
}

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FMCPBridgeRuntimeModule, MCPBridgeRuntime)
