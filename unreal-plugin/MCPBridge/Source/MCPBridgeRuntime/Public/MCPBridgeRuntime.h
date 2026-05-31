// MCPBridgeRuntime.h
// Public header for the MCPBridgeRuntime module.
// Exposes the module interface and the TCP server singleton.

#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"

class MCPBRIDGERUNTIME_API FMCPBridgeRuntimeModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;
};
