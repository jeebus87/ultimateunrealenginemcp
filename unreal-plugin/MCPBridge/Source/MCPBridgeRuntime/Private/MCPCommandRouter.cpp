// MCPCommandRouter.cpp
// Implementation of FMCPCommandRouter.
// All handler dispatches go through AsyncTask(ENamedThreads::GameThread) to protect
// UE editor API calls from being invoked on a background network-receive thread.

#include "MCPCommandRouter.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Async/Async.h"

FMCPCommandRouter::FMCPCommandRouter()
{
	// Register built-in ping handler.
	// ping validates the full round-trip: TypeScript -> TCP -> C++ -> AsyncTask -> response.
	RegisterHandler(TEXT("ping"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		// This lambda runs on the game thread (dispatched by Dispatch() below).
		const FString CorrelationId = Cmd.IsValid() ? Cmd->GetStringField(TEXT("correlationId")) : TEXT("");

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetBoolField(TEXT("pong"), true);

		TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
		Response->SetBoolField(TEXT("success"), true);
		if (!CorrelationId.IsEmpty())
		{
			Response->SetStringField(TEXT("correlationId"), CorrelationId);
		}
		Response->SetObjectField(TEXT("data"), Data);

		FString Output;
		TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		FJsonSerializer::Serialize(Response.ToSharedRef(), Writer);
		Output += TEXT("\n");
		SendResponse(Output);
	});
}

void FMCPCommandRouter::RegisterHandler(const FString& CommandType, FMCPCommandHandler Handler)
{
	Handlers.Add(CommandType, MoveTemp(Handler));
}

void FMCPCommandRouter::Dispatch(const FString& RawMessage, FMCPResponseSender SendResponse) const
{
	// Parse the incoming JSON.
	TSharedPtr<FJsonObject> JsonObj;
	TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RawMessage);
	if (!FJsonSerializer::Deserialize(Reader, JsonObj) || !JsonObj.IsValid())
	{
		// T-07-04: malformed JSON must not crash -- return structured error.
		SendResponse(BuildErrorResponse(TEXT(""), TEXT("invalid_json")) + TEXT("\n"));
		return;
	}

	FString CorrelationId;
	JsonObj->TryGetStringField(TEXT("correlationId"), CorrelationId);

	FString CommandType;
	if (!JsonObj->TryGetStringField(TEXT("type"), CommandType) || CommandType.IsEmpty())
	{
		SendResponse(BuildErrorResponse(CorrelationId, TEXT("missing_type")) + TEXT("\n"));
		return;
	}

	const FMCPCommandHandler* HandlerPtr = Handlers.Find(CommandType);
	if (!HandlerPtr)
	{
		SendResponse(BuildErrorResponse(CorrelationId, TEXT("unknown_command")) + TEXT("\n"));
		return;
	}

	// Capture handler and response sender by value -- safe across async boundary.
	FMCPCommandHandler Handler = *HandlerPtr;

	// All UE API calls must run on the game thread (Pitfall 2: game-thread assertions).
	// This wrapping is applied universally -- handlers must never call UE APIs directly
	// from a background thread.
	AsyncTask(ENamedThreads::GameThread, [Handler, JsonObj, SendResponse, CorrelationId]()
	{
		// Inject correlationId back into JsonObj so handlers can read it if needed.
		JsonObj->SetStringField(TEXT("correlationId"), CorrelationId);
		Handler(JsonObj, SendResponse);
	});
}

FString FMCPCommandRouter::BuildErrorResponse(const FString& CorrelationId, const FString& Error)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetBoolField(TEXT("success"), false);
	if (!CorrelationId.IsEmpty())
	{
		Obj->SetStringField(TEXT("correlationId"), CorrelationId);
	}
	Obj->SetStringField(TEXT("error"), Error);

	FString Output;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	return Output;
}

FString FMCPCommandRouter::BuildSuccessResponse(const FString& CorrelationId, TSharedPtr<FJsonObject> Data)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetBoolField(TEXT("success"), true);
	Obj->SetStringField(TEXT("correlationId"), CorrelationId);
	if (Data.IsValid())
	{
		Obj->SetObjectField(TEXT("data"), Data);
	}

	FString Output;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	return Output;
}
