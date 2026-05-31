// MCPBridgeEditor.h
// Public header for the MCPBridgeEditor module.

#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"

class FMCPBridgeEditorModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;
};
