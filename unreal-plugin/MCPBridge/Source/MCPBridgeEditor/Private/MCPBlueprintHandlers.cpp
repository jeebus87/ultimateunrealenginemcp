// MCPBlueprintHandlers.cpp
// Implements blueprint.read, blueprint.graph, and blueprint.list command handlers.
// All handlers are registered on the FMCPCommandRouter and run on the game thread
// (enforced by FMCPCommandRouter::Dispatch via AsyncTask).
//
// Response format matches the ping handler pattern in MCPCommandRouter.cpp:
//   { success: bool, correlationId: string, data: {...} } + "\n"

#include "MCPBlueprintHandlers.h"

#include "MCPCommandRouter.h"

// Blueprint APIs
#include "Engine/Blueprint.h"
#include "BlueprintEditorUtils.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "Engine/SimpleConstructionScript.h"
#include "Engine/SCS_Node.h"

// K2Node APIs — required for blueprint.cppUsage graph scanning
#include "K2Node_CallFunction.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"

// Asset Registry APIs
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetRegistry/AssetData.h"
#include "Blueprint/BlueprintTags.h"

// JSON APIs
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

void RegisterBlueprintHandlers(FMCPCommandRouter& Router)
{
	// ---------------------------------------------------------------------------
	// Shared response helpers captured by value in each handler lambda.
	// ---------------------------------------------------------------------------

	auto SendSuccess = [](FMCPResponseSender SendResponse,
	                      const FString& CorrelationId,
	                      TSharedPtr<FJsonObject> Data)
	{
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
	};

	auto SendError = [](FMCPResponseSender SendResponse,
	                    const FString& CorrelationId,
	                    const FString& ErrorCode)
	{
		TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
		Response->SetBoolField(TEXT("success"), false);
		if (!CorrelationId.IsEmpty())
		{
			Response->SetStringField(TEXT("correlationId"), CorrelationId);
		}
		Response->SetStringField(TEXT("error"), ErrorCode);

		FString Output;
		TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		FJsonSerializer::Serialize(Response.ToSharedRef(), Writer);
		Output += TEXT("\n");
		SendResponse(Output);
	};

	// ---------------------------------------------------------------------------
	// blueprint.read
	// Input payload: { "asset_path": "/Game/Blueprints/BP_MyActor" }
	// Returns: { assetPath, parentClass, variables[], components[] }
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("blueprint.read"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		// Extract asset_path from payload
		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		FString AssetPath;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj) ||
		    !(*PayloadObj)->TryGetStringField(TEXT("asset_path"), AssetPath) ||
		    AssetPath.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_asset_path"));
			return;
		}

		// Load the Blueprint asset via UE asset system (never parses .uasset binary directly)
		UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AssetPath);
		if (!BP)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.read: Blueprint not found at path '%s'"), *AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("blueprint_not_found"));
			return;
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("assetPath"), AssetPath);
		Data->SetStringField(TEXT("parentClass"),
			BP->ParentClass ? BP->ParentClass->GetName() : TEXT("None"));

		// Variables: iterate BP->NewVariables (member variables defined in the Blueprint)
		TArray<TSharedPtr<FJsonValue>> VarArray;
		for (const FBPVariableDescription& Var : BP->NewVariables)
		{
			TSharedPtr<FJsonObject> VarObj = MakeShared<FJsonObject>();
			VarObj->SetStringField(TEXT("name"), Var.VarName.ToString());
			VarObj->SetStringField(TEXT("type"), Var.VarType.PinCategory.ToString());
			VarArray.Add(MakeShared<FJsonValueObject>(VarObj));
		}
		Data->SetArrayField(TEXT("variables"), VarArray);

		// Components: iterate SimpleConstructionScript nodes (actor component tree)
		TArray<TSharedPtr<FJsonValue>> CompArray;
		if (BP->SimpleConstructionScript)
		{
			for (USCS_Node* Node : BP->SimpleConstructionScript->GetAllNodes())
			{
				if (!Node || !Node->ComponentTemplate)
				{
					continue;
				}
				TSharedPtr<FJsonObject> CompObj = MakeShared<FJsonObject>();
				CompObj->SetStringField(TEXT("name"), Node->GetVariableName().ToString());
				CompObj->SetStringField(TEXT("class"), Node->ComponentTemplate->GetClass()->GetName());
				CompArray.Add(MakeShared<FJsonValueObject>(CompObj));
			}
		}
		Data->SetArrayField(TEXT("components"), CompArray);

		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// blueprint.graph
	// Input payload: { "asset_path": "/Game/Blueprints/BP_MyActor", "graph_name": "EventGraph" }
	//   graph_name is optional -- defaults to "EventGraph"
	// Returns: { assetPath, graphName, nodes[], connections[] }
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("blueprint.graph"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		// Extract asset_path and optional graph_name from payload
		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		FString AssetPath;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj) ||
		    !(*PayloadObj)->TryGetStringField(TEXT("asset_path"), AssetPath) ||
		    AssetPath.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_asset_path"));
			return;
		}

		FString GraphName = TEXT("EventGraph");
		(*PayloadObj)->TryGetStringField(TEXT("graph_name"), GraphName);

		// Load the Blueprint asset
		UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AssetPath);
		if (!BP)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.graph: Blueprint not found at path '%s'"), *AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("blueprint_not_found"));
			return;
		}

		// Search UbergraphPages (event graphs) then FunctionGraphs for the named graph
		UEdGraph* TargetGraph = nullptr;
		for (UEdGraph* Graph : BP->UbergraphPages)
		{
			if (Graph && Graph->GetName() == GraphName)
			{
				TargetGraph = Graph;
				break;
			}
		}
		if (!TargetGraph)
		{
			for (UEdGraph* Graph : BP->FunctionGraphs)
			{
				if (Graph && Graph->GetName() == GraphName)
				{
					TargetGraph = Graph;
					break;
				}
			}
		}
		// Default to first ubergraph if "EventGraph" was requested and not found by name
		if (!TargetGraph && GraphName == TEXT("EventGraph") && BP->UbergraphPages.Num() > 0)
		{
			TargetGraph = BP->UbergraphPages[0];
		}
		if (!TargetGraph)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.graph: Graph '%s' not found in '%s'"),
				*GraphName, *AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("graph_not_found"));
			return;
		}

		// Serialize nodes with their pins
		TArray<TSharedPtr<FJsonValue>> NodeArray;
		for (UEdGraphNode* Node : TargetGraph->Nodes)
		{
			if (!Node)
			{
				continue;
			}

			TSharedPtr<FJsonObject> NodeObj = MakeShared<FJsonObject>();
			NodeObj->SetStringField(TEXT("nodeGuid"), Node->NodeGuid.ToString());
			NodeObj->SetStringField(TEXT("type"), Node->GetClass()->GetName());
			NodeObj->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::FullTitle).ToString());
			NodeObj->SetNumberField(TEXT("posX"), Node->NodePosX);
			NodeObj->SetNumberField(TEXT("posY"), Node->NodePosY);

			// Serialize pins
			TArray<TSharedPtr<FJsonValue>> PinArray;
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin)
				{
					continue;
				}
				TSharedPtr<FJsonObject> PinObj = MakeShared<FJsonObject>();
				PinObj->SetStringField(TEXT("pinName"), Pin->PinName.ToString());
				PinObj->SetStringField(TEXT("direction"),
					Pin->Direction == EGPD_Input ? TEXT("input") : TEXT("output"));
				PinObj->SetStringField(TEXT("type"), Pin->PinType.PinCategory.ToString());
				PinObj->SetStringField(TEXT("defaultValue"), Pin->DefaultValue);
				PinArray.Add(MakeShared<FJsonValueObject>(PinObj));
			}
			NodeObj->SetArrayField(TEXT("pins"), PinArray);
			NodeArray.Add(MakeShared<FJsonValueObject>(NodeObj));
		}

		// Serialize connections: walk output pins and their LinkedTo list
		TArray<TSharedPtr<FJsonValue>> ConnArray;
		for (UEdGraphNode* Node : TargetGraph->Nodes)
		{
			if (!Node)
			{
				continue;
			}
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin || Pin->Direction != EGPD_Output)
				{
					continue;
				}
				for (UEdGraphPin* LinkedPin : Pin->LinkedTo)
				{
					if (!LinkedPin || !LinkedPin->GetOwningNode())
					{
						continue;
					}
					TSharedPtr<FJsonObject> Conn = MakeShared<FJsonObject>();
					Conn->SetStringField(TEXT("fromNodeGuid"), Node->NodeGuid.ToString());
					Conn->SetStringField(TEXT("fromPinName"), Pin->PinName.ToString());
					Conn->SetStringField(TEXT("toNodeGuid"), LinkedPin->GetOwningNode()->NodeGuid.ToString());
					Conn->SetStringField(TEXT("toPinName"), LinkedPin->PinName.ToString());
					ConnArray.Add(MakeShared<FJsonValueObject>(Conn));
				}
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("assetPath"), AssetPath);
		Data->SetStringField(TEXT("graphName"), TargetGraph->GetName());
		Data->SetArrayField(TEXT("nodes"), NodeArray);
		Data->SetArrayField(TEXT("connections"), ConnArray);

		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// blueprint.list
	// Input payload: { "path_prefix": "/Game/Blueprints/" }  (path_prefix optional)
	// Returns: { blueprints[], count }
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("blueprint.list"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		// Extract optional path_prefix from payload
		FString PathPrefix;
		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		if (Command->TryGetObjectField(TEXT("payload"), PayloadObj))
		{
			(*PayloadObj)->TryGetStringField(TEXT("path_prefix"), PathPrefix);
		}

		// Query the Asset Registry for all Blueprint assets
		IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(
			TEXT("AssetRegistry")).Get();

		FARFilter Filter;
		Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());
		Filter.bRecursivePaths = true;
		if (!PathPrefix.IsEmpty())
		{
			Filter.PackagePaths.Add(FName(*PathPrefix));
		}

		TArray<FAssetData> Assets;
		AR.GetAssets(Filter, Assets);

		TArray<TSharedPtr<FJsonValue>> AssetArray;
		for (const FAssetData& Asset : Assets)
		{
			TSharedPtr<FJsonObject> AssetObj = MakeShared<FJsonObject>();
			AssetObj->SetStringField(TEXT("assetPath"), Asset.GetSoftObjectPath().ToString());
			AssetObj->SetStringField(TEXT("packagePath"), Asset.PackagePath.ToString());

			// ParentClass is stored as a tag on Blueprint assets in the asset registry
			FString ParentClass;
			Asset.GetTagValue(FBlueprintTags::ParentClassPath, ParentClass);
			AssetObj->SetStringField(TEXT("parentClass"), ParentClass);

			AssetArray.Add(MakeShared<FJsonValueObject>(AssetObj));
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetArrayField(TEXT("blueprints"), AssetArray);
		Data->SetNumberField(TEXT("count"), AssetArray.Num());

		SendSuccess(SendResponse, CorrelationId, Data);
	});
}

void RegisterBlueprintBridgeHandlers(FMCPCommandRouter& Router)
{
	// ---------------------------------------------------------------------------
	// Shared response helpers — same pattern as RegisterBlueprintHandlers above.
	// ---------------------------------------------------------------------------

	auto SendSuccess = [](FMCPResponseSender SendResponse,
	                      const FString& CorrelationId,
	                      TSharedPtr<FJsonObject> Data)
	{
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
	};

	auto SendError = [](FMCPResponseSender SendResponse,
	                    const FString& CorrelationId,
	                    const FString& ErrorCode)
	{
		TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
		Response->SetBoolField(TEXT("success"), false);
		if (!CorrelationId.IsEmpty())
		{
			Response->SetStringField(TEXT("correlationId"), CorrelationId);
		}
		Response->SetStringField(TEXT("error"), ErrorCode);

		FString Output;
		TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		FJsonSerializer::Serialize(Response.ToSharedRef(), Writer);
		Output += TEXT("\n");
		SendResponse(Output);
	};

	// ---------------------------------------------------------------------------
	// blueprint.subclasses
	// Input payload: { "class_name": "AMyActor" }
	// Returns: { className, subclasses[] } where each entry has { assetPath, packagePath, parentClassTag }
	//
	// Uses asset registry tag filtering only — does NOT call LoadObject to avoid loading
	// potentially thousands of Blueprint assets for a class hierarchy query.
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("blueprint.subclasses"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		// Extract class_name from payload (T-11-01: validate non-empty before query)
		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		FString ClassName;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj) ||
		    !(*PayloadObj)->TryGetStringField(TEXT("class_name"), ClassName) ||
		    ClassName.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_class_name"));
			return;
		}

		// Query the Asset Registry for all Blueprint assets (no path prefix — search entire project)
		IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(
			TEXT("AssetRegistry")).Get();

		FARFilter Filter;
		Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());
		Filter.bRecursivePaths = true;

		TArray<FAssetData> Assets;
		AR.GetAssets(Filter, Assets);

		// Filter by ParentClassPath tag — match if the tag value contains the requested class_name.
		// The tag value is typically "/Script/MyGame.AMyActor" so a Contains check is appropriate.
		TArray<TSharedPtr<FJsonValue>> SubclassArray;
		for (const FAssetData& Asset : Assets)
		{
			FString ParentClassTag;
			Asset.GetTagValue(FBlueprintTags::ParentClassPath, ParentClassTag);

			if (ParentClassTag.IsEmpty())
			{
				continue;
			}

			// Case-sensitive contains — class names are case-sensitive in C++/UE
			if (ParentClassTag.Contains(ClassName))
			{
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("assetPath"), Asset.GetSoftObjectPath().ToString());
				Entry->SetStringField(TEXT("packagePath"), Asset.PackagePath.ToString());
				Entry->SetStringField(TEXT("parentClassTag"), ParentClassTag);
				SubclassArray.Add(MakeShared<FJsonValueObject>(Entry));
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("className"), ClassName);
		Data->SetArrayField(TEXT("subclasses"), SubclassArray);

		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// blueprint.cppUsage
	// Input payload: { "class_name": "AMyActor", "member_name": "Attack" }
	// Returns: { className, memberName, usages[], count }
	//   Each usage: { assetPath, graphName, nodeType, nodeTitle }
	//
	// Scans UK2Node_CallFunction, UK2Node_VariableGet, and UK2Node_VariableSet nodes
	// across all Blueprint graphs (UbergraphPages + FunctionGraphs).
	// LoadObject is called per asset — this is intentional and expected to be slow on
	// large projects (T-11-02: accepted DoS risk — editor-only, not a production path).
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("blueprint.cppUsage"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		// Extract class_name and member_name from payload
		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		FString ClassName;
		FString MemberName;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj))
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_parameters"));
			return;
		}
		(*PayloadObj)->TryGetStringField(TEXT("class_name"), ClassName);
		(*PayloadObj)->TryGetStringField(TEXT("member_name"), MemberName);

		if (ClassName.IsEmpty() || MemberName.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_parameters"));
			return;
		}

		// Query the Asset Registry for all Blueprint assets
		IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(
			TEXT("AssetRegistry")).Get();

		FARFilter Filter;
		Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());
		Filter.bRecursivePaths = true;

		TArray<FAssetData> Assets;
		AR.GetAssets(Filter, Assets);

		// Collect usage records — deduplicated by assetPath+graphName+nodeType+nodeTitle
		TSet<FString> SeenKeys;
		TArray<TSharedPtr<FJsonValue>> UsageArray;

		for (const FAssetData& AssetData : Assets)
		{
			const FString AssetPath = AssetData.GetSoftObjectPath().ToString();

			// Load the Blueprint to access its graphs
			UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AssetPath);
			if (!BP)
			{
				continue;
			}

			// Build a combined list of graphs to scan: event graphs + function graphs
			TArray<UEdGraph*> AllGraphs;
			AllGraphs.Append(BP->UbergraphPages);
			AllGraphs.Append(BP->FunctionGraphs);

			for (UEdGraph* Graph : AllGraphs)
			{
				if (!Graph)
				{
					continue;
				}

				const FString GraphName = Graph->GetName();

				for (UEdGraphNode* Node : Graph->Nodes)
				{
					if (!Node)
					{
						continue;
					}

					bool bMatched = false;

					// Check UK2Node_CallFunction: match member_name AND owning class contains class_name
					if (UK2Node_CallFunction* CallNode = Cast<UK2Node_CallFunction>(Node))
					{
						if (CallNode->FunctionReference.GetMemberName().ToString() == MemberName)
						{
							// Check if the function's parent class name contains class_name
							UClass* MemberParent = CallNode->FunctionReference.GetMemberParentClass();
							const bool bClassMatch = MemberParent
								? MemberParent->GetName().Contains(ClassName)
								: false;

							// Also accept if the blueprint's parent class tag contains class_name
							FString ParentClassTag;
							AssetData.GetTagValue(FBlueprintTags::ParentClassPath, ParentClassTag);
							const bool bTagMatch = ParentClassTag.Contains(ClassName);

							if (bClassMatch || bTagMatch)
							{
								bMatched = true;
							}
						}
					}
					// Check UK2Node_VariableGet: match member_name only (variable names are unique within scope)
					else if (UK2Node_VariableGet* GetNode = Cast<UK2Node_VariableGet>(Node))
					{
						if (GetNode->VariableReference.GetMemberName().ToString() == MemberName)
						{
							bMatched = true;
						}
					}
					// Check UK2Node_VariableSet: match member_name only
					else if (UK2Node_VariableSet* SetNode = Cast<UK2Node_VariableSet>(Node))
					{
						if (SetNode->VariableReference.GetMemberName().ToString() == MemberName)
						{
							bMatched = true;
						}
					}

					if (bMatched)
					{
						const FString NodeType  = Node->GetClass()->GetName();
						const FString NodeTitle = Node->GetNodeTitle(ENodeTitleType::FullTitle).ToString();

						// Deduplicate by composite key
						const FString DedupeKey = AssetPath + TEXT("|") + GraphName + TEXT("|") + NodeType + TEXT("|") + NodeTitle;
						if (!SeenKeys.Contains(DedupeKey))
						{
							SeenKeys.Add(DedupeKey);

							TSharedPtr<FJsonObject> Usage = MakeShared<FJsonObject>();
							Usage->SetStringField(TEXT("assetPath"), AssetPath);
							Usage->SetStringField(TEXT("graphName"), GraphName);
							Usage->SetStringField(TEXT("nodeType"), NodeType);
							Usage->SetStringField(TEXT("nodeTitle"), NodeTitle);
							UsageArray.Add(MakeShared<FJsonValueObject>(Usage));
						}
					}
				}
			}
		}

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("className"), ClassName);
		Data->SetStringField(TEXT("memberName"), MemberName);
		Data->SetArrayField(TEXT("usages"), UsageArray);
		Data->SetNumberField(TEXT("count"), UsageArray.Num());

		SendSuccess(SendResponse, CorrelationId, Data);
	});
}
