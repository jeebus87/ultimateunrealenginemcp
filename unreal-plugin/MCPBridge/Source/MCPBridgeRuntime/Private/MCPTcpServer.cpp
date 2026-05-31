// MCPTcpServer.cpp
// TCP server implementation for MCPBridge.
// Binds exclusively to 127.0.0.1 (FIPv4Address::InternalLoopback).
// Ticks at 20 Hz via FTSTicker to accept connections and read data without
// blocking the game thread.

#include "MCPTcpServer.h"
#include "SocketSubsystem.h"
#include "Common/TcpSocketBuilder.h"
#include "Interfaces/IPv4/IPv4Address.h"
#include "Interfaces/IPv4/IPv4Endpoint.h"

FMCPTcpServer::FMCPTcpServer(FMCPCommandRouter& InRouter)
	: Router(InRouter)
{
}

FMCPTcpServer::~FMCPTcpServer()
{
	Stop();
}

bool FMCPTcpServer::Start(int32 Port)
{
	// Bind to loopback only -- never 0.0.0.0 (CONTEXT.md security constraint).
	FIPv4Endpoint Endpoint(FIPv4Address::InternalLoopback, static_cast<uint16>(Port));

	ListenerSocket = FTcpSocketBuilder(TEXT("MCPBridge.Listener"))
		.AsReusable()
		.BoundToEndpoint(Endpoint)
		.Listening(8)
		.Build();

	if (!ListenerSocket)
	{
		UE_LOG(LogTemp, Error, TEXT("[MCPBridge] Failed to bind TCP listener on 127.0.0.1:%d"), Port);
		return false;
	}

	ListenerSocket->SetNonBlocking(true);
	bRunning = true;

	// 20 Hz tick -- low overhead, <50ms latency for interactive editor commands.
	TickerHandle = FTSTicker::GetCoreTicker().AddTicker(
		FTickerDelegate::CreateRaw(this, &FMCPTcpServer::Tick), 0.05f);

	UE_LOG(LogTemp, Log, TEXT("[MCPBridge] TCP server listening on 127.0.0.1:%d"), Port);
	return true;
}

void FMCPTcpServer::Stop()
{
	if (!bRunning)
	{
		return;
	}
	bRunning = false;

	if (TickerHandle.IsValid())
	{
		FTSTicker::GetCoreTicker().RemoveTicker(TickerHandle);
		TickerHandle.Reset();
	}

	ISocketSubsystem* SocketSS = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);

	for (FMCPClientState& Client : Clients)
	{
		if (Client.Socket)
		{
			Client.Socket->Close();
			SocketSS->DestroySocket(Client.Socket);
		}
	}
	Clients.Empty();

	if (ListenerSocket)
	{
		ListenerSocket->Close();
		SocketSS->DestroySocket(ListenerSocket);
		ListenerSocket = nullptr;
	}

	UE_LOG(LogTemp, Log, TEXT("[MCPBridge] TCP server stopped."));
}

bool FMCPTcpServer::Tick(float /*DeltaTime*/)
{
	if (!bRunning)
	{
		return false;  // Remove ticker
	}
	AcceptConnections();
	ReadClients();
	return true;  // Keep ticking
}

void FMCPTcpServer::AcceptConnections()
{
	if (!ListenerSocket)
	{
		return;
	}

	bool bHasPendingConnection = false;
	while (ListenerSocket->HasPendingConnection(bHasPendingConnection) && bHasPendingConnection)
	{
		FSocket* ClientSocket = ListenerSocket->Accept(TEXT("MCPBridge.Client"));
		if (ClientSocket)
		{
			ClientSocket->SetNonBlocking(true);
			FMCPClientState State;
			State.Socket = ClientSocket;
			Clients.Add(MoveTemp(State));
			UE_LOG(LogTemp, Log, TEXT("[MCPBridge] Client connected."));
		}
	}
}

void FMCPTcpServer::ReadClients()
{
	ISocketSubsystem* SocketSS = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);

	for (int32 i = Clients.Num() - 1; i >= 0; --i)
	{
		FMCPClientState& Client = Clients[i];

		if (!Client.Socket || Client.Socket->GetConnectionState() != SCS_Connected)
		{
			// Clean up disconnected client.
			if (Client.Socket)
			{
				Client.Socket->Close();
				SocketSS->DestroySocket(Client.Socket);
				Client.Socket = nullptr;
			}
			Clients.RemoveAt(i);
			UE_LOG(LogTemp, Log, TEXT("[MCPBridge] Client disconnected."));
			continue;
		}

		uint32 PendingSize = 0;
		while (Client.Socket->HasPendingData(PendingSize) && PendingSize > 0)
		{
			TArray<uint8> Buffer;
			Buffer.SetNumUninitialized(PendingSize);
			int32 BytesRead = 0;
			if (!Client.Socket->Recv(Buffer.GetData(), Buffer.Num(), BytesRead) || BytesRead <= 0)
			{
				break;
			}

			// Null-terminate and convert UTF-8 bytes to TCHAR string.
			Buffer.Add(0);
			FUTF8ToTCHAR Converter(reinterpret_cast<const ANSICHAR*>(Buffer.GetData()), BytesRead);
			Client.ReceiveBuffer.Append(Converter.Get(), Converter.Length());

			// Process all complete lines (delimited by \n).
			int32 NewlinePos;
			while (Client.ReceiveBuffer.FindChar(TEXT('\n'), NewlinePos))
			{
				FString Message = Client.ReceiveBuffer.Left(NewlinePos).TrimEnd();
				Client.ReceiveBuffer.RightChopInline(NewlinePos + 1);

				if (!Message.IsEmpty())
				{
					// Capture socket pointer for response callback.
					// Router.Dispatch() dispatches the handler to the game thread via AsyncTask.
					// The SendResponse lambda captures Sock -- valid because clients are only
					// destroyed on the next tick after disconnect detection.
					FSocket* Sock = Client.Socket;
					Router.Dispatch(Message, [this, Sock](const FString& Response)
					{
						SendResponse(Sock, Response);
					});
				}
			}
		}
	}
}

void FMCPTcpServer::SendResponse(FSocket* ClientSocket, const FString& Response)
{
	if (!ClientSocket || Response.IsEmpty())
	{
		return;
	}

	// Convert TCHAR string to UTF-8 bytes for sending over the wire.
	FTCHARToUTF8 Converter(*Response);
	const uint8* Data = reinterpret_cast<const uint8*>(Converter.Get());
	int32 Size = Converter.Length();
	int32 BytesSent = 0;

	ClientSocket->Send(Data, Size, BytesSent);
}
