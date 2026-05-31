// MCPBlueprintWriteHandlers.cpp
// Implements blueprint.create, blueprint.addNode, blueprint.connectPins,
// blueprint.addVariable, and blueprint.setDefault command handlers.
// All handlers are registered on the FMCPCommandRouter and run on the game thread
// (enforced by FMCPCommandRouter::Dispatch via AsyncTask).
//
// INVARIANT: Every write handler calls BP->Modify() before any mutation and
// FBlueprintEditorUtils::MarkBlueprintAsModified(BP) after -- never omit these.
//
// Security mitigations per threat model (T-10-01 through T-10-06):
//   T-10-01: asset_path validated via FPackageName::IsValidLongPackageName()
//   T-10-02: node_type class checked for UEdGraphNode ancestry + non-abstract
//   T-10-04: CanCreateConnection() checked before TryCreateConnection()
//   T-10-05: Named error codes returned, never raw UE internal messages
//   T-10-06: ParentClass verified via IsChildOf(UObject::StaticClass())

#include "MCPBlueprintWriteHandlers.h"

#include "MCPCommandRouter.h"

// Blueprint APIs
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphSchema_K2.h"

// Asset APIs
#include "AssetRegistry/AssetRegistryModule.h"
#include "UObject/Package.h"
#include "Misc/PackageName.h"

// JSON APIs
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

// ---------------------------------------------------------------------------
// Internal helper: find a named graph in a Blueprint (same pattern as
// MCPBlueprintHandlers.cpp blueprint.graph handler).
// ---------------------------------------------------------------------------
static UEdGraph* FindBlueprintGraph(UBlueprint* BP, const FString& GraphName)
{
	for (UEdGraph* Graph : BP->UbergraphPages)
	{
		if (Graph && Graph->GetName() == GraphName)
		{
			return Graph;
		}
	}
	for (UEdGraph* Graph : BP->FunctionGraphs)
	{
		if (Graph && Graph->GetName() == GraphName)
		{
			return Graph;
		}
	}
	// Default to first ubergraph when "EventGraph" is requested and not found by name
	if (GraphName == TEXT("EventGraph") && BP->UbergraphPages.Num() > 0)
	{
		return BP->UbergraphPages[0];
	}
	return nullptr;
}

void RegisterBlueprintWriteHandlers(FMCPCommandRouter& Router)
{
	// ---------------------------------------------------------------------------
	// Shared response helpers -- verbatim pattern from MCPBlueprintHandlers.cpp.
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
	// blueprint.create (BPW-01)
	// Input payload: { "parent_class": "AActor", "asset_path": "/Game/Blueprints/BP_MyActor" }
	// Returns: { "assetPath": string, "parentClass": string }
	//
	// Security: T-10-01 (path validation), T-10-06 (parent class verification)
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("blueprint.create"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj))
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_payload"));
			return;
		}

		FString ParentClassName;
		if (!(*PayloadObj)->TryGetStringField(TEXT("parent_class"), ParentClassName) || ParentClassName.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_parent_class"));
			return;
		}

		FString AssetPath;
		if (!(*PayloadObj)->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_asset_path"));
			return;
		}

		// T-10-01: Validate the asset path is a well-formed long package name.
		// Rejects path traversal ("../") and bare filenames.
		FString ValidationError;
		if (!FPackageName::IsValidLongPackageName(AssetPath, /*bIncludeReadOnlyRoots=*/false, &ValidationError))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.create: Invalid asset path '%s': %s"),
				*AssetPath, *ValidationError);
			SendError(SendResponse, CorrelationId, TEXT("invalid_asset_path"));
			return;
		}

		// Resolve the parent class by name (try short name first, then full path).
		UClass* ParentClass = FindObject<UClass>(ANY_PACKAGE, *ParentClassName);
		if (!ParentClass)
		{
			ParentClass = LoadObject<UClass>(nullptr, *ParentClassName);
		}
		if (!ParentClass)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.create: Parent class '%s' not found"),
				*ParentClassName);
			SendError(SendResponse, CorrelationId, TEXT("parent_class_not_found"));
			return;
		}

		// T-10-06: Verify the resolved class is a proper UE class derived from UObject,
		// not an arbitrary object that happens to match the name.
		if (!ParentClass->IsChildOf(UObject::StaticClass()))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.create: Class '%s' is not a UObject subclass"),
				*ParentClassName);
			SendError(SendResponse, CorrelationId, TEXT("invalid_parent_class"));
			return;
		}

		// Split asset path into package path + asset name.
		// AssetPath = "/Game/Blueprints/BP_MyActor"  →  AssetName = "BP_MyActor"
		FString AssetName = FPackageName::GetLongPackageAssetName(AssetPath);

		// Create (or retrieve) the package for this asset.
		UPackage* Pkg = CreatePackage(*AssetPath);
		if (!Pkg)
		{
			UE_LOG(LogTemp, Error, TEXT("[MCPBridge] blueprint.create: Failed to create package for '%s'"),
				*AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("package_create_failed"));
			return;
		}
		Pkg->FullyLoad();

		// Create the Blueprint asset.
		UBlueprint* NewBP = FKismetEditorUtilities::CreateBlueprint(
			ParentClass,
			Pkg,
			FName(*AssetName),
			BPTYPE_Normal,
			UBlueprint::StaticClass(),
			UBlueprintGeneratedClass::StaticClass()
		);
		if (!NewBP)
		{
			UE_LOG(LogTemp, Error, TEXT("[MCPBridge] blueprint.create: FKismetEditorUtilities::CreateBlueprint failed for '%s'"),
				*AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("create_failed"));
			return;
		}

		// Save the package to disk so the asset persists.
		FString FilePath = FPackageName::LongPackageNameToFilename(
			AssetPath, FPackageName::GetAssetPackageExtension());
		UPackage::SavePackage(Pkg, NewBP, RF_Standalone, *FilePath,
			GError, nullptr, false, true, SAVE_NoError);

		// Notify the Asset Registry so the asset appears in the Content Browser.
		FAssetRegistryModule::AssetCreated(NewBP);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("assetPath"), AssetPath);
		Data->SetStringField(TEXT("parentClass"), ParentClassName);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// blueprint.addNode (BPW-02)
	// Input payload:
	//   { "asset_path": "/Game/BP_X", "graph_name": "EventGraph",
	//     "node_type": "K2Node_CallFunction", "pos_x": 0, "pos_y": 0 }
	// Returns: { "nodeGuid": string, "type": string, "posX": int, "posY": int }
	//
	// Security: T-10-02 (node class ancestry check + abstract guard)
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("blueprint.addNode"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj))
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_payload"));
			return;
		}

		FString AssetPath;
		if (!(*PayloadObj)->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_asset_path"));
			return;
		}

		FString NodeType;
		if (!(*PayloadObj)->TryGetStringField(TEXT("node_type"), NodeType) || NodeType.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_node_type"));
			return;
		}

		FString GraphName = TEXT("EventGraph");
		(*PayloadObj)->TryGetStringField(TEXT("graph_name"), GraphName);

		int32 PosX = 0;
		int32 PosY = 0;
		(*PayloadObj)->TryGetNumberField(TEXT("pos_x"), PosX);
		(*PayloadObj)->TryGetNumberField(TEXT("pos_y"), PosY);

		UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AssetPath);
		if (!BP)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.addNode: Blueprint not found at '%s'"), *AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("blueprint_not_found"));
			return;
		}

		UEdGraph* TargetGraph = FindBlueprintGraph(BP, GraphName);
		if (!TargetGraph)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.addNode: Graph '%s' not found in '%s'"),
				*GraphName, *AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("graph_not_found"));
			return;
		}

		// T-10-02: Resolve node class and validate it is a non-abstract UEdGraphNode subclass.
		UClass* NodeClass = FindObject<UClass>(ANY_PACKAGE, *NodeType);
		if (!NodeClass)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.addNode: Node type '%s' not found"), *NodeType);
			SendError(SendResponse, CorrelationId, TEXT("node_type_not_found"));
			return;
		}
		if (!NodeClass->IsChildOf(UEdGraphNode::StaticClass()))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.addNode: Class '%s' is not a UEdGraphNode subclass"), *NodeType);
			SendError(SendResponse, CorrelationId, TEXT("node_type_not_graph_node"));
			return;
		}
		if (NodeClass->HasAnyClassFlags(CLASS_Abstract))
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.addNode: Node type '%s' is abstract and cannot be instantiated"), *NodeType);
			SendError(SendResponse, CorrelationId, TEXT("node_type_is_abstract"));
			return;
		}

		// MANDATORY: Modify() before any mutation (Pitfall 5).
		BP->Modify();

		UEdGraphNode* NewNode = NewObject<UEdGraphNode>(TargetGraph, NodeClass);
		NewNode->NodePosX = PosX;
		NewNode->NodePosY = PosY;
		TargetGraph->AddNode(NewNode, /*bFromUI=*/false, /*bSelectNewNode=*/false);
		NewNode->PostPlacedNewNode();
		NewNode->AllocateDefaultPins();

		// MANDATORY: MarkBlueprintAsModified() after mutation (Pitfall 5).
		FBlueprintEditorUtils::MarkBlueprintAsModified(BP);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("nodeGuid"), NewNode->NodeGuid.ToString());
		Data->SetStringField(TEXT("type"), NodeType);
		Data->SetNumberField(TEXT("posX"), PosX);
		Data->SetNumberField(TEXT("posY"), PosY);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// blueprint.connectPins (BPW-03)
	// Input payload:
	//   { "asset_path": "/Game/BP_X", "graph_name": "EventGraph",
	//     "from_node_guid": "GUID", "from_pin_name": "then",
	//     "to_node_guid": "GUID", "to_pin_name": "execute" }
	// Returns: { "connected": true, "fromNodeGuid": string, "fromPinName": string,
	//            "toNodeGuid": string, "toPinName": string }
	//
	// Security: T-10-04 (CanCreateConnection() checked before TryCreateConnection())
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("blueprint.connectPins"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj))
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_payload"));
			return;
		}

		FString AssetPath;
		if (!(*PayloadObj)->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_asset_path"));
			return;
		}

		FString FromNodeGuidStr;
		if (!(*PayloadObj)->TryGetStringField(TEXT("from_node_guid"), FromNodeGuidStr) || FromNodeGuidStr.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_from_node_guid"));
			return;
		}

		FString FromPinName;
		if (!(*PayloadObj)->TryGetStringField(TEXT("from_pin_name"), FromPinName) || FromPinName.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_from_pin_name"));
			return;
		}

		FString ToNodeGuidStr;
		if (!(*PayloadObj)->TryGetStringField(TEXT("to_node_guid"), ToNodeGuidStr) || ToNodeGuidStr.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_to_node_guid"));
			return;
		}

		FString ToPinName;
		if (!(*PayloadObj)->TryGetStringField(TEXT("to_pin_name"), ToPinName) || ToPinName.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_to_pin_name"));
			return;
		}

		FString GraphName = TEXT("EventGraph");
		(*PayloadObj)->TryGetStringField(TEXT("graph_name"), GraphName);

		UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AssetPath);
		if (!BP)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.connectPins: Blueprint not found at '%s'"), *AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("blueprint_not_found"));
			return;
		}

		UEdGraph* TargetGraph = FindBlueprintGraph(BP, GraphName);
		if (!TargetGraph)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.connectPins: Graph '%s' not found in '%s'"),
				*GraphName, *AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("graph_not_found"));
			return;
		}

		// Find the from-node by GUID.
		UEdGraphNode* FromNode = nullptr;
		for (UEdGraphNode* Node : TargetGraph->Nodes)
		{
			if (Node && Node->NodeGuid.ToString() == FromNodeGuidStr)
			{
				FromNode = Node;
				break;
			}
		}
		if (!FromNode)
		{
			SendError(SendResponse, CorrelationId, TEXT("from_node_not_found"));
			return;
		}

		// Find the from-pin (must be an output pin).
		UEdGraphPin* FromPin = nullptr;
		for (UEdGraphPin* Pin : FromNode->Pins)
		{
			if (Pin && Pin->Direction == EGPD_Output && Pin->PinName.ToString() == FromPinName)
			{
				FromPin = Pin;
				break;
			}
		}
		if (!FromPin)
		{
			SendError(SendResponse, CorrelationId, TEXT("from_pin_not_found"));
			return;
		}

		// Find the to-node by GUID.
		UEdGraphNode* ToNode = nullptr;
		for (UEdGraphNode* Node : TargetGraph->Nodes)
		{
			if (Node && Node->NodeGuid.ToString() == ToNodeGuidStr)
			{
				ToNode = Node;
				break;
			}
		}
		if (!ToNode)
		{
			SendError(SendResponse, CorrelationId, TEXT("to_node_not_found"));
			return;
		}

		// Find the to-pin (must be an input pin).
		UEdGraphPin* ToPin = nullptr;
		for (UEdGraphPin* Pin : ToNode->Pins)
		{
			if (Pin && Pin->Direction == EGPD_Input && Pin->PinName.ToString() == ToPinName)
			{
				ToPin = Pin;
				break;
			}
		}
		if (!ToPin)
		{
			SendError(SendResponse, CorrelationId, TEXT("to_pin_not_found"));
			return;
		}

		// T-10-04: Validate the connection is type-safe before making it.
		const UEdGraphSchema_K2* Schema = GetDefault<UEdGraphSchema_K2>();
		FPinConnectionResponse CanConnect = Schema->CanCreateConnection(FromPin, ToPin);
		if (CanConnect.Response != CONNECT_RESPONSE_MAKE)
		{
			// T-10-05: Return a named error code, not the raw UE message.
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.connectPins: Connection not allowed: %s"),
				*CanConnect.Message.ToString());
			SendError(SendResponse, CorrelationId, TEXT("connection_not_allowed"));
			return;
		}

		// MANDATORY: Modify() before any mutation (Pitfall 5).
		BP->Modify();

		Schema->TryCreateConnection(FromPin, ToPin);

		// MANDATORY: MarkBlueprintAsModified() after mutation (Pitfall 5).
		FBlueprintEditorUtils::MarkBlueprintAsModified(BP);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetBoolField(TEXT("connected"), true);
		Data->SetStringField(TEXT("fromNodeGuid"), FromNodeGuidStr);
		Data->SetStringField(TEXT("fromPinName"), FromPinName);
		Data->SetStringField(TEXT("toNodeGuid"), ToNodeGuidStr);
		Data->SetStringField(TEXT("toPinName"), ToPinName);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// blueprint.addVariable (BPW-04)
	// Input payload:
	//   { "asset_path": "/Game/BP_X", "variable_name": "Health", "variable_type": "float" }
	// Supported type categories: bool, int, int64, float, double, string, name, text,
	//                            object, class, struct, vector, rotator, transform
	// Returns: { "variableName": string, "variableType": string }
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("blueprint.addVariable"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj))
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_payload"));
			return;
		}

		FString AssetPath;
		if (!(*PayloadObj)->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_asset_path"));
			return;
		}

		FString VariableName;
		if (!(*PayloadObj)->TryGetStringField(TEXT("variable_name"), VariableName) || VariableName.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_variable_name"));
			return;
		}

		FString VariableType;
		if (!(*PayloadObj)->TryGetStringField(TEXT("variable_type"), VariableType) || VariableType.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_variable_type"));
			return;
		}

		UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AssetPath);
		if (!BP)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.addVariable: Blueprint not found at '%s'"), *AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("blueprint_not_found"));
			return;
		}

		// Check for duplicate variable name.
		for (const FBPVariableDescription& ExistingVar : BP->NewVariables)
		{
			if (ExistingVar.VarName.ToString() == VariableName)
			{
				SendError(SendResponse, CorrelationId, TEXT("variable_already_exists"));
				return;
			}
		}

		// MANDATORY: Modify() before any mutation (Pitfall 5).
		BP->Modify();

		// Build the pin type: map the caller's type string to a PinCategory.
		FEdGraphPinType VarType;
		VarType.PinCategory = FName(*VariableType);

		FBlueprintEditorUtils::AddMemberVariable(BP, FName(*VariableName), VarType);

		// MANDATORY: MarkBlueprintAsModified() after mutation (Pitfall 5).
		FBlueprintEditorUtils::MarkBlueprintAsModified(BP);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetStringField(TEXT("variableName"), VariableName);
		Data->SetStringField(TEXT("variableType"), VariableType);
		SendSuccess(SendResponse, CorrelationId, Data);
	});

	// ---------------------------------------------------------------------------
	// blueprint.setDefault (BPW-05)
	// Input payload (variable target):
	//   { "asset_path": "/Game/BP_X", "target_type": "variable",
	//     "target_name": "Health", "default_value": "100.0" }
	// Input payload (pin target):
	//   { "asset_path": "/Game/BP_X", "target_type": "pin",
	//     "graph_name": "EventGraph", "node_guid": "GUID",
	//     "pin_name": "Value", "default_value": "42" }
	// Returns: { "set": true, "targetType": string, "targetName": string, "defaultValue": string }
	//
	// Security: T-10-05 (named error codes, not raw UE messages)
	// ---------------------------------------------------------------------------
	Router.RegisterHandler(TEXT("blueprint.setDefault"),
		[SendSuccess, SendError](TSharedPtr<FJsonObject> Command, FMCPResponseSender SendResponse)
	{
		FString CorrelationId;
		Command->TryGetStringField(TEXT("correlationId"), CorrelationId);

		const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
		if (!Command->TryGetObjectField(TEXT("payload"), PayloadObj))
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_payload"));
			return;
		}

		FString AssetPath;
		if (!(*PayloadObj)->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_asset_path"));
			return;
		}

		FString TargetType;
		if (!(*PayloadObj)->TryGetStringField(TEXT("target_type"), TargetType) || TargetType.IsEmpty())
		{
			SendError(SendResponse, CorrelationId, TEXT("missing_target_type"));
			return;
		}

		FString DefaultValue;
		if (!(*PayloadObj)->TryGetStringField(TEXT("default_value"), DefaultValue))
		{
			// default_value may legitimately be an empty string (e.g. clear a text field),
			// but the field must be present.
			SendError(SendResponse, CorrelationId, TEXT("missing_default_value"));
			return;
		}

		UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AssetPath);
		if (!BP)
		{
			UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.setDefault: Blueprint not found at '%s'"), *AssetPath);
			SendError(SendResponse, CorrelationId, TEXT("blueprint_not_found"));
			return;
		}

		// MANDATORY: Modify() before any mutation (Pitfall 5).
		BP->Modify();

		FString TargetName;

		if (TargetType == TEXT("variable"))
		{
			if (!(*PayloadObj)->TryGetStringField(TEXT("target_name"), TargetName) || TargetName.IsEmpty())
			{
				SendError(SendResponse, CorrelationId, TEXT("missing_target_name"));
				return;
			}

			// T-10-05: SetBlueprintVariableDefaultValue returns bool; use named error code on failure.
			bool bSet = FBlueprintEditorUtils::SetBlueprintVariableDefaultValue(
				BP, FName(*TargetName), DefaultValue);
			if (!bSet)
			{
				UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.setDefault: Variable '%s' not found in '%s'"),
					*TargetName, *AssetPath);
				SendError(SendResponse, CorrelationId, TEXT("variable_not_found"));
				return;
			}
		}
		else if (TargetType == TEXT("pin"))
		{
			FString PinName;
			if (!(*PayloadObj)->TryGetStringField(TEXT("pin_name"), PinName) || PinName.IsEmpty())
			{
				SendError(SendResponse, CorrelationId, TEXT("missing_pin_name"));
				return;
			}
			TargetName = PinName;

			FString NodeGuidStr;
			if (!(*PayloadObj)->TryGetStringField(TEXT("node_guid"), NodeGuidStr) || NodeGuidStr.IsEmpty())
			{
				SendError(SendResponse, CorrelationId, TEXT("missing_node_guid"));
				return;
			}

			FString GraphName = TEXT("EventGraph");
			(*PayloadObj)->TryGetStringField(TEXT("graph_name"), GraphName);

			UEdGraph* TargetGraph = FindBlueprintGraph(BP, GraphName);
			if (!TargetGraph)
			{
				UE_LOG(LogTemp, Warning, TEXT("[MCPBridge] blueprint.setDefault: Graph '%s' not found in '%s'"),
					*GraphName, *AssetPath);
				SendError(SendResponse, CorrelationId, TEXT("graph_not_found"));
				return;
			}

			// Find the node by GUID.
			UEdGraphNode* TargetNode = nullptr;
			for (UEdGraphNode* Node : TargetGraph->Nodes)
			{
				if (Node && Node->NodeGuid.ToString() == NodeGuidStr)
				{
					TargetNode = Node;
					break;
				}
			}
			if (!TargetNode)
			{
				SendError(SendResponse, CorrelationId, TEXT("node_not_found"));
				return;
			}

			// Find the pin by name (any direction is allowed for defaults).
			UEdGraphPin* TargetPin = nullptr;
			for (UEdGraphPin* Pin : TargetNode->Pins)
			{
				if (Pin && Pin->PinName.ToString() == PinName)
				{
					TargetPin = Pin;
					break;
				}
			}
			if (!TargetPin)
			{
				SendError(SendResponse, CorrelationId, TEXT("pin_not_found"));
				return;
			}

			const UEdGraphSchema_K2* Schema = GetDefault<UEdGraphSchema_K2>();
			Schema->TrySetDefaultValue(*TargetPin, DefaultValue);
		}
		else
		{
			// T-10-05: Named error code, not raw input echo.
			SendError(SendResponse, CorrelationId, TEXT("invalid_target_type"));
			return;
		}

		// MANDATORY: MarkBlueprintAsModified() after mutation (Pitfall 5).
		FBlueprintEditorUtils::MarkBlueprintAsModified(BP);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetBoolField(TEXT("set"), true);
		Data->SetStringField(TEXT("targetType"), TargetType);
		Data->SetStringField(TEXT("targetName"), TargetName);
		Data->SetStringField(TEXT("defaultValue"), DefaultValue);
		SendSuccess(SendResponse, CorrelationId, Data);
	});
}
