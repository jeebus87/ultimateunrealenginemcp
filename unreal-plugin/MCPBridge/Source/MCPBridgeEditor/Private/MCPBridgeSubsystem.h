// MCPBridgeSubsystem.h (updated by Plan 07-02)
// UEditorSubsystem that owns the TCP server lifecycle.
// Initialize() creates the router, starts the server.
// Deinitialize() stops the server and resets owners.
//
// Port is read from engine config key [MCPBridge] Port= (default: 55557).
// Bind address is always 127.0.0.1 -- never 0.0.0.0.

#pragma once

#include "CoreMinimal.h"
#include "EditorSubsystem.h"
#include "MCPTcpServer.h"
#include "MCPCommandRouter.h"
#include "MCPBridgeSubsystem.generated.h"

UCLASS()
class UMCPBridgeSubsystem : public UEditorSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

private:
	/** Read port from [MCPBridge] Port= in engine config, fallback to 55557. */
	int32 GetConfiguredPort() const;

	/** Command router -- registers built-in ping handler on construction. */
	TUniquePtr<FMCPCommandRouter> Router;

	/** TCP server -- bound to 127.0.0.1:Port, ticks at 20 Hz via FTSTicker. */
	TUniquePtr<FMCPTcpServer> TcpServer;

	/** True while the TCP server is running. */
	bool bServerRunning = false;
};
