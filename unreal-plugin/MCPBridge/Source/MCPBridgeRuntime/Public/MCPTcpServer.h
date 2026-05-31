// MCPTcpServer.h
// FSocket-based TCP server for the MCP bridge.
// Binds to 127.0.0.1:PORT (NEVER 0.0.0.0 -- see CONTEXT.md security constraint).
// Uses FTSTicker for non-blocking periodic accept/read at 20 Hz.
// Each message is one JSON object terminated by \n (JSON-newline framing).
//
// Per-client receive state is held in FMCPClientState to handle partial reads.

#pragma once

#include "CoreMinimal.h"
#include "MCPCommandRouter.h"
#include "Sockets.h"
#include "Containers/Ticker.h"

/**
 * Holds per-connection state: socket handle + partial receive buffer.
 */
struct FMCPClientState
{
	FSocket* Socket = nullptr;
	FString  ReceiveBuffer;  // accumulates bytes until \n is found
};

/**
 * TCP server bound to 127.0.0.1:PORT.
 * Owns the listener socket, all client sockets, and the ticker.
 */
class MCPBRIDGERUNTIME_API FMCPTcpServer
{
public:
	explicit FMCPTcpServer(FMCPCommandRouter& InRouter);
	~FMCPTcpServer();

	/** Bind listener socket and start the FTSTicker. Returns false on bind failure. */
	bool Start(int32 Port);

	/** Close all client sockets, listener socket, and remove the ticker. */
	void Stop();

private:
	/** Called at 20 Hz by FTSTicker. Accepts new connections and reads pending data. */
	bool Tick(float DeltaTime);

	/** Accept any pending new connections from the listener socket. */
	void AcceptConnections();

	/** Read all pending data from each connected client, dispatch complete messages. */
	void ReadClients();

	/** Send a JSON-newline response to a specific client socket. */
	void SendResponse(FSocket* ClientSocket, const FString& Response);

	FMCPCommandRouter&         Router;
	FSocket*                   ListenerSocket = nullptr;
	TArray<FMCPClientState>    Clients;
	FTSTicker::FDelegateHandle TickerHandle;
	bool                       bRunning = false;
};
