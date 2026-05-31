// MCPCommandRouter.h
// Routes incoming JSON-newline commands to registered handlers.
// ALL handler invocations are dispatched via AsyncTask(ENamedThreads::GameThread).
// This is non-retrofittable -- establish this pattern before any real handlers exist.
//
// Usage (from Phases 8-12):
//   Router.RegisterHandler(TEXT("get_actors"), [](TSharedPtr<FJsonObject> Cmd,
//       FMCPResponseSender Send) { /* editor API call -- runs on game thread */ });

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Callback type for sending a JSON response back to the connected client. */
using FMCPResponseSender = TFunction<void(const FString& JsonResponse)>;

/**
 * Handler signature: receives parsed command object, sends response via SendResponse.
 * Guaranteed to run on the game thread -- safe to call any UE editor API.
 */
using FMCPCommandHandler = TFunction<void(TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)>;

class MCPBRIDGERUNTIME_API FMCPCommandRouter
{
public:
	FMCPCommandRouter();

	/**
	 * Register a handler for a command type.
	 * Call this during plugin initialization (before any connections arrive).
	 * Not thread-safe after the server is accepting connections.
	 */
	void RegisterHandler(const FString& CommandType, FMCPCommandHandler Handler);

	/**
	 * Dispatch an incoming JSON-newline message.
	 * Parses JSON, looks up handler, dispatches on game thread via AsyncTask.
	 * If no handler registered, sends {success:false, error:"unknown_command"}.
	 * SendResponse is guaranteed to be called exactly once per Dispatch call.
	 *
	 * @param RawMessage  Raw JSON string (without trailing newline).
	 * @param SendResponse Callback to send the JSON response back to the client.
	 */
	void Dispatch(const FString& RawMessage, FMCPResponseSender SendResponse) const;

private:
	/** Builds a JSON error response with the given correlationId and error string. */
	static FString BuildErrorResponse(const FString& CorrelationId, const FString& Error);

	/** Builds a JSON success response with the given correlationId and data object. */
	static FString BuildSuccessResponse(const FString& CorrelationId, TSharedPtr<FJsonObject> Data);

	TMap<FString, FMCPCommandHandler> Handlers;
};
