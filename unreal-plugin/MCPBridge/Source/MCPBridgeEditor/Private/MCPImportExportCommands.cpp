// MCPImportExportCommands.cpp (Plan 33-02)
// Reflection-based asset import/export command handlers for the MCP bridge.
// Implements four handlers:
//   import.fbx    -- import an FBX file at a specified content path (IMP-01)
//   import.usd    -- import a USD file using the Interchange pipeline (IMP-02)
//   export.mesh   -- export a static or skeletal mesh to FBX format (IMP-03)
//   import.batch  -- batch import multiple files from a directory (IMP-04)
//
// Optional FBX module headers are NOT included.
// UFbxFactory is accessed via FindObject<UClass> and properties set via FProperty reflection.
// Optional Interchange module headers are NOT included.
// UInterchangeManager and UInterchangeSourceData are accessed via reflection when available.
//
// All handlers dispatch via AsyncTask(ENamedThreads::GameThread, ...).
// Validate source_file paths exist on disk before import (T-21-01, T-21-04).
// Validate asset_path starts with /Game/ or /Engine/ (T-21-03).
// Reject output_file paths containing ".." and validate .fbx extension (T-21-02).

#include "MCPImportExportCommands.h"

#include "Editor.h"
#include "Engine/World.h"

// Asset import/export APIs -- always available in UnrealEd
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AssetImportTask.h"
#include "Misc/PackageName.h"

// Mesh types -- always available
#include "Engine/StaticMesh.h"
#include "Engine/SkeletalMesh.h"
#include "Exporters/Exporter.h"

// File system -- always available
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "HAL/FileManager.h"

// Core modules -- always available
#include "Modules/ModuleManager.h"
#include "UObject/UnrealType.h"
#include "UObject/PropertyPortFlags.h"
#include "UObject/UObjectGlobals.h"

// JSON -- always available
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

// Async
#include "Async/TaskGraphInterfaces.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a JSON success response string (without trailing newline). */
static FString BuildImpSuccessResponse(const FString& CorrId, TSharedPtr<FJsonObject> Data)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetBoolField(TEXT("success"), true);
	Obj->SetStringField(TEXT("correlationId"), CorrId);
	if (Data.IsValid())
	{
		Obj->SetObjectField(TEXT("data"), Data);
	}

	FString Output;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	return Output;
}

/** Returns a JSON error response string (without trailing newline). */
static FString BuildImpErrorResponse(const FString& CorrId, const FString& Error)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetBoolField(TEXT("success"), false);
	Obj->SetStringField(TEXT("correlationId"), CorrId);
	Obj->SetStringField(TEXT("error"), Error);

	FString Output;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
	return Output;
}

/**
 * Validate that asset_path starts with "/Game/" or "/Engine/" to prevent
 * path traversal attacks (T-21-03).
 */
static bool IsValidAssetPath(const FString& AssetPath)
{
	return AssetPath.StartsWith(TEXT("/Game/")) || AssetPath.StartsWith(TEXT("/Engine/"));
}

/**
 * Validate that a file path on disk is safe:
 * - Must not contain ".." to prevent path traversal (T-21-01, T-21-02, T-21-04).
 * - Must exist on disk.
 */
static bool IsValidFilePath(const FString& FilePath)
{
	if (FilePath.Contains(TEXT("..")))
	{
		return false;
	}
	return FPaths::FileExists(FilePath);
}

/**
 * Create a UFbxFactory instance via reflection (FindObject<UClass>).
 * The FBX factory lives in UnrealEd which IS in Build.cs, but we avoid including
 * the FBX-specific header by using FindObject<UClass> and property reflection.
 */
static UObject* CreateFbxFactory(bool bImportMaterials, bool bCombineMeshes, float ScaleFactor)
{
	// UFbxFactory is in UnrealEd (which IS in our Build.cs as a dependency).
	// We use FindObject<UClass> to avoid including the FBX-specific header.
	UClass* FbxFactoryClass = FindObject<UClass>(nullptr, TEXT("/Script/UnrealEd.FbxFactory"));
	if (!FbxFactoryClass)
	{
		return nullptr;
	}

	UObject* FbxFactory = NewObject<UObject>(GetTransientPackage(), FbxFactoryClass);
	if (!FbxFactory)
	{
		return nullptr;
	}

	// Access ImportUI (UFbxImportUI*) via reflection.
	FObjectProperty* ImportUIProp = CastField<FObjectProperty>(
		FbxFactoryClass->FindPropertyByName(TEXT("ImportUI")));
	if (!ImportUIProp)
	{
		return FbxFactory; // Factory created without UI config.
	}

	UObject* ImportUI = ImportUIProp->GetObjectPropertyValue_InContainer(FbxFactory);
	if (!ImportUI)
	{
		return FbxFactory;
	}

	// Set bImportMaterials on ImportUI.
	FBoolProperty* ImportMaterialsProp = CastField<FBoolProperty>(
		ImportUI->GetClass()->FindPropertyByName(TEXT("bImportMaterials")));
	if (ImportMaterialsProp)
	{
		ImportMaterialsProp->SetPropertyValue_InContainer(ImportUI, bImportMaterials);
	}

	// Access StaticMeshImportData (UFbxStaticMeshImportData*) via reflection.
	FObjectProperty* StaticMeshDataProp = CastField<FObjectProperty>(
		ImportUI->GetClass()->FindPropertyByName(TEXT("StaticMeshImportData")));
	if (StaticMeshDataProp)
	{
		UObject* StaticMeshData = StaticMeshDataProp->GetObjectPropertyValue_InContainer(ImportUI);
		if (StaticMeshData)
		{
			FBoolProperty* CombineMeshesProp = CastField<FBoolProperty>(
				StaticMeshData->GetClass()->FindPropertyByName(TEXT("bCombineMeshes")));
			if (CombineMeshesProp)
			{
				CombineMeshesProp->SetPropertyValue_InContainer(StaticMeshData, bCombineMeshes);
			}

			FFloatProperty* ScaleFactorProp = CastField<FFloatProperty>(
				StaticMeshData->GetClass()->FindPropertyByName(TEXT("ImportUniformScale")));
			if (ScaleFactorProp)
			{
				ScaleFactorProp->SetPropertyValue_InContainer(StaticMeshData, ScaleFactor);
			}
		}
	}

	return FbxFactory;
}

// ---------------------------------------------------------------------------
// RegisterImportExportCommands
// ---------------------------------------------------------------------------

void RegisterImportExportCommands(FMCPCommandRouter& Router)
{
	// -----------------------------------------------------------------------
	// import.fbx (IMP-01)
	// Imports an FBX file to a UE content path.
	// Returns JSON with "assets" array of created asset paths and "count".
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("import.fbx"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString SourceFile;
		FString DestPath;

		if (!Payload.IsValid()
			|| !Payload->TryGetStringField(TEXT("source_file"), SourceFile) || SourceFile.IsEmpty()
			|| !Payload->TryGetStringField(TEXT("dest_path"), DestPath) || DestPath.IsEmpty())
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("missing_required_fields")) + TEXT("\n"));
			return;
		}

		// Validate source file exists and is safe (T-21-01).
		if (SourceFile.Contains(TEXT("..")) || !FPaths::FileExists(SourceFile))
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("source_file_not_found")) + TEXT("\n"));
			return;
		}

		// Validate destination content path (T-21-03).
		if (!IsValidAssetPath(DestPath))
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("invalid_dest_path")) + TEXT("\n"));
			return;
		}

		// Extract optional settings.
		bool bImportMaterials = true;
		bool bCombineMeshes = false;
		double ScaleFactor = 1.0;
		Payload->TryGetBoolField(TEXT("import_materials"), bImportMaterials);
		Payload->TryGetBoolField(TEXT("combine_meshes"), bCombineMeshes);
		Payload->TryGetNumberField(TEXT("scale_factor"), ScaleFactor);

		// Capture everything for async dispatch.
		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse, SourceFile, DestPath,
			bImportMaterials, bCombineMeshes, ScaleFactor]()
		{
			// Split dest_path into package path + asset name.
			FString PackagePath = DestPath;
			FString AssetName;

			if (DestPath.EndsWith(TEXT("/")))
			{
				AssetName = FPaths::GetBaseFilename(SourceFile);
				PackagePath = DestPath.LeftChop(1);
			}
			else
			{
				AssetName = FPackageName::GetLongPackageAssetName(DestPath);
				PackagePath = FPackageName::GetLongPackagePath(DestPath);
				if (AssetName.IsEmpty())
				{
					AssetName = FPaths::GetBaseFilename(SourceFile);
					PackagePath = DestPath;
				}
			}

			// Get AssetTools module.
			IAssetTools& AT = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();

			// Create UAssetImportTask.
			UAssetImportTask* Task = NewObject<UAssetImportTask>();
			Task->Filename = SourceFile;
			Task->DestinationPath = PackagePath;
			Task->DestinationName = AssetName;
			Task->bAutomated = true;
			Task->bReplaceExisting = true;
			Task->bSave = true;

			// Create UFbxFactory via reflection (avoids including FBX-specific headers).
			UObject* FbxFactory = CreateFbxFactory(bImportMaterials, bCombineMeshes, static_cast<float>(ScaleFactor));
			if (FbxFactory)
			{
				// Task->Factory expects a UFactory* -- use reflection to set it.
				FObjectProperty* FactoryProp = CastField<FObjectProperty>(
					Task->GetClass()->FindPropertyByName(TEXT("Factory")));
				if (FactoryProp)
				{
					FactoryProp->SetObjectPropertyValue_InContainer(Task, FbxFactory);
				}
			}

			// Run the import.
			TArray<UAssetImportTask*> Tasks;
			Tasks.Add(Task);
			AT.ImportAssetTasks(Tasks);

			// Collect imported asset paths.
			TArray<TSharedPtr<FJsonValue>> AssetsArray;
			for (const FString& ImportedPath : Task->ImportedObjectPaths)
			{
				AssetsArray.Add(MakeShared<FJsonValueString>(ImportedPath));
			}

			if (AssetsArray.Num() == 0)
			{
				UE_LOG(LogTemp, Warning, TEXT("[MCPImportExport] import.fbx produced no imported assets for: %s"), *SourceFile);
			}

			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetArrayField(TEXT("assets"), AssetsArray);
			Data->SetNumberField(TEXT("count"), static_cast<double>(AssetsArray.Num()));

			SendResponse(BuildImpSuccessResponse(CorrId, Data) + TEXT("\n"));
		});
	});

	// -----------------------------------------------------------------------
	// import.usd (IMP-02)
	// Imports a USD/USDA/USDC file using the Interchange pipeline.
	// Falls back to UAssetImportTask if InterchangeEngine is unavailable.
	// Returns JSON with "assets" array of created asset paths and "count".
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("import.usd"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString SourceFile;
		FString DestPath;

		if (!Payload.IsValid()
			|| !Payload->TryGetStringField(TEXT("source_file"), SourceFile) || SourceFile.IsEmpty()
			|| !Payload->TryGetStringField(TEXT("dest_path"), DestPath) || DestPath.IsEmpty())
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("missing_required_fields")) + TEXT("\n"));
			return;
		}

		// Validate source file exists and is safe (T-21-01).
		if (SourceFile.Contains(TEXT("..")) || !FPaths::FileExists(SourceFile))
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("source_file_not_found")) + TEXT("\n"));
			return;
		}

		// Validate USD extension.
		const FString Ext = FPaths::GetExtension(SourceFile).ToLower();
		if (Ext != TEXT("usd") && Ext != TEXT("usda") && Ext != TEXT("usdc"))
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("invalid_usd_extension")) + TEXT("\n"));
			return;
		}

		// Validate destination content path (T-21-03).
		if (!IsValidAssetPath(DestPath))
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("invalid_dest_path")) + TEXT("\n"));
			return;
		}

		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse, SourceFile, DestPath]()
		{
			// Attempt Interchange import first (via reflection -- no Interchange headers included).
			bool bInterchangeUsed = false;
			TArray<TSharedPtr<FJsonValue>> AssetsArray;

			if (GEditor && FModuleManager::Get().IsModuleLoaded(TEXT("InterchangeEngine")))
			{
				// Find UInterchangeManager via reflection.
				UClass* InterchangeManagerClass = FindObject<UClass>(nullptr,
					TEXT("/Script/InterchangeEngine.InterchangeManager"));
				if (InterchangeManagerClass)
				{
					// UInterchangeManager has a static GetInterchangeManager() function.
					UFunction* GetManagerFunc = InterchangeManagerClass->FindFunctionByName(TEXT("GetInterchangeManager"));
					if (GetManagerFunc)
					{
						TArray<uint8> Params;
						Params.SetNumZeroed(GetManagerFunc->ParmsSize);

						// ProcessEvent on the CDO to call a static-like function.
						UObject* CDO = InterchangeManagerClass->GetDefaultObject();
						CDO->ProcessEvent(GetManagerFunc, Params.GetData());

						// Get the returned manager object.
						UObject* InterchangeManager = nullptr;
						for (TFieldIterator<FProperty> PIt(GetManagerFunc); PIt; ++PIt)
						{
							FProperty* P = *PIt;
							if (P->PropertyFlags & CPF_ReturnParm)
							{
								if (FObjectProperty* ObjProp = CastField<FObjectProperty>(P))
								{
									InterchangeManager = ObjProp->GetObjectPropertyValue(Params.GetData() + P->GetOffset_ForInternal());
								}
								break;
							}
						}

						if (InterchangeManager)
						{
							// Normalize dest_path to directory.
							FString ContentDir = DestPath;
							if (!ContentDir.EndsWith(TEXT("/")))
							{
								FString LastPart = FPackageName::GetLongPackageAssetName(ContentDir);
								if (!LastPart.IsEmpty())
								{
									ContentDir = FPackageName::GetLongPackagePath(ContentDir);
								}
							}

							// Create UInterchangeSourceData via reflection.
							UClass* SourceDataClass = FindObject<UClass>(nullptr,
								TEXT("/Script/InterchangeCore.InterchangeSourceData"));
							if (SourceDataClass)
							{
								UObject* SourceData = NewObject<UObject>(GetTransientPackage(), SourceDataClass);
								if (SourceData)
								{
									// Set the filename via SetFilename function or Filename property.
									UFunction* SetFilenameFunc = SourceData->GetClass()->FindFunctionByName(TEXT("SetFilename"));
									if (SetFilenameFunc)
									{
										TArray<uint8> SetParams;
										SetParams.SetNumZeroed(SetFilenameFunc->ParmsSize);
										for (TFieldIterator<FProperty> PIt(SetFilenameFunc); PIt && (PIt->PropertyFlags & CPF_Parm); ++PIt)
										{
											FProperty* P = *PIt;
											if (P->PropertyFlags & CPF_ReturnParm) { continue; }
											if (FStrProperty* StrParam = CastField<FStrProperty>(P))
											{
												StrParam->SetPropertyValue(SetParams.GetData() + P->GetOffset_ForInternal(), SourceFile);
												break;
											}
										}
										SourceData->ProcessEvent(SetFilenameFunc, SetParams.GetData());
									}
									else
									{
										// Set via FStrProperty directly.
										FStrProperty* FilenameStrProp = CastField<FStrProperty>(
											SourceData->GetClass()->FindPropertyByName(TEXT("Filename")));
										if (FilenameStrProp)
										{
											FilenameStrProp->SetPropertyValue_InContainer(SourceData, SourceFile);
										}
									}

									// Call ImportAsset(ContentDir, SourceData, Params) via reflection.
									// FImportAssetParameters is a struct -- create it zeroed.
									UFunction* ImportAssetFunc = InterchangeManager->GetClass()->FindFunctionByName(TEXT("ImportAsset"));
									if (ImportAssetFunc)
									{
										TArray<uint8> ImportParams;
										ImportParams.SetNumZeroed(ImportAssetFunc->ParmsSize);

										for (TFieldIterator<FProperty> PIt(ImportAssetFunc); PIt && (PIt->PropertyFlags & CPF_Parm); ++PIt)
										{
											FProperty* P = *PIt;
											if (P->PropertyFlags & CPF_ReturnParm) { continue; }

											if (FStrProperty* StrParam = CastField<FStrProperty>(P))
											{
												// Content directory parameter.
												StrParam->SetPropertyValue(ImportParams.GetData() + P->GetOffset_ForInternal(), ContentDir);
											}
											else if (FObjectProperty* ObjParam = CastField<FObjectProperty>(P))
											{
												// SourceData parameter.
												ObjParam->SetObjectPropertyValue(ImportParams.GetData() + P->GetOffset_ForInternal(), SourceData);
											}
											else if (FStructProperty* StructParam = CastField<FStructProperty>(P))
											{
												// FImportAssetParameters -- set bIsAutomated = true.
												void* StructPtr = ImportParams.GetData() + P->GetOffset_ForInternal();
												FBoolProperty* IsAutomatedProp = CastField<FBoolProperty>(
													StructParam->Struct->FindPropertyByName(TEXT("bIsAutomated")));
												if (IsAutomatedProp)
												{
													IsAutomatedProp->SetPropertyValue_InContainer(StructPtr, true);
												}
											}
										}

										InterchangeManager->ProcessEvent(ImportAssetFunc, ImportParams.GetData());
										bInterchangeUsed = true;

										UE_LOG(LogTemp, Log,
											TEXT("[MCPImportExport] import.usd: Interchange import initiated for: %s -> %s"),
											*SourceFile, *ContentDir);
									}
								}
							}
						}
					}
				}
			}

			if (bInterchangeUsed)
			{
				// Interchange is async; we report success with empty assets list.
				TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
				Data->SetArrayField(TEXT("assets"), AssetsArray);
				Data->SetNumberField(TEXT("count"), static_cast<double>(AssetsArray.Num()));
				Data->SetStringField(TEXT("method"), TEXT("interchange"));
				Data->SetBoolField(TEXT("async"), true);
				SendResponse(BuildImpSuccessResponse(CorrId, Data) + TEXT("\n"));
				return;
			}

			// Fallback: use UAssetImportTask (UE auto-detects USD factory).
			UE_LOG(LogTemp, Warning,
				TEXT("[MCPImportExport] import.usd: InterchangeEngine not available; falling back to UAssetImportTask for: %s"),
				*SourceFile);

			FString PackagePath = DestPath;
			FString AssetName;

			if (DestPath.EndsWith(TEXT("/")))
			{
				AssetName = FPaths::GetBaseFilename(SourceFile);
				PackagePath = DestPath.LeftChop(1);
			}
			else
			{
				AssetName = FPackageName::GetLongPackageAssetName(DestPath);
				PackagePath = FPackageName::GetLongPackagePath(DestPath);
				if (AssetName.IsEmpty())
				{
					AssetName = FPaths::GetBaseFilename(SourceFile);
					PackagePath = DestPath;
				}
			}

			IAssetTools& AT = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();

			UAssetImportTask* Task = NewObject<UAssetImportTask>();
			Task->Filename = SourceFile;
			Task->DestinationPath = PackagePath;
			Task->DestinationName = AssetName;
			Task->bAutomated = true;
			Task->bReplaceExisting = true;
			Task->bSave = true;
			// No factory override -- let UE auto-detect the USD factory.

			TArray<UAssetImportTask*> Tasks;
			Tasks.Add(Task);
			AT.ImportAssetTasks(Tasks);

			for (const FString& ImportedPath : Task->ImportedObjectPaths)
			{
				AssetsArray.Add(MakeShared<FJsonValueString>(ImportedPath));
			}

			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetArrayField(TEXT("assets"), AssetsArray);
			Data->SetNumberField(TEXT("count"), static_cast<double>(AssetsArray.Num()));
			Data->SetStringField(TEXT("method"), TEXT("fallback"));
			Data->SetBoolField(TEXT("async"), false);

			SendResponse(BuildImpSuccessResponse(CorrId, Data) + TEXT("\n"));
		});
	});

	// -----------------------------------------------------------------------
	// export.mesh (IMP-03)
	// Exports a StaticMesh or SkeletalMesh asset to an FBX file on disk.
	// Returns JSON with "output_file" string, "exported" bool, "asset_class".
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("export.mesh"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString AssetPath;
		FString OutputFile;

		if (!Payload.IsValid()
			|| !Payload->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty()
			|| !Payload->TryGetStringField(TEXT("output_file"), OutputFile) || OutputFile.IsEmpty())
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("missing_required_fields")) + TEXT("\n"));
			return;
		}

		// Validate asset path (T-21-03).
		if (!IsValidAssetPath(AssetPath))
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("invalid_asset_path")) + TEXT("\n"));
			return;
		}

		// Validate output file -- reject ".." (T-21-02) and require .fbx extension.
		if (OutputFile.Contains(TEXT("..")))
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("invalid_output_path")) + TEXT("\n"));
			return;
		}
		const FString OutputExt = FPaths::GetExtension(OutputFile).ToLower();
		if (OutputExt != TEXT("fbx"))
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("output_file_must_be_fbx")) + TEXT("\n"));
			return;
		}

		// Optional parameters.
		bool bExportCollision = false;
		double LevelOfDetail = 0.0;
		if (Payload.IsValid())
		{
			Payload->TryGetBoolField(TEXT("export_collision"), bExportCollision);
			Payload->TryGetNumberField(TEXT("level_of_detail"), LevelOfDetail);
		}
		const int32 LODIndex = static_cast<int32>(LevelOfDetail);

		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse, AssetPath, OutputFile, bExportCollision, LODIndex]()
		{
			// Load the mesh asset (StaticMesh or SkeletalMesh).
			UObject* MeshObject = StaticLoadObject(UObject::StaticClass(), nullptr, *AssetPath);
			if (!MeshObject)
			{
				SendResponse(BuildImpErrorResponse(CorrId, TEXT("asset_not_found")) + TEXT("\n"));
				return;
			}

			UStaticMesh* StaticMesh = Cast<UStaticMesh>(MeshObject);
			USkeletalMesh* SkeletalMesh = Cast<USkeletalMesh>(MeshObject);

			if (!StaticMesh && !SkeletalMesh)
			{
				SendResponse(BuildImpErrorResponse(CorrId, TEXT("asset_not_mesh")) + TEXT("\n"));
				return;
			}

			const FString AssetClass = StaticMesh ? TEXT("StaticMesh") : TEXT("SkeletalMesh");

			// Ensure the output directory exists.
			const FString OutputDir = FPaths::GetPath(OutputFile);
			if (!OutputDir.IsEmpty() && !IFileManager::Get().DirectoryExists(*OutputDir))
			{
				IFileManager::Get().MakeDirectory(*OutputDir, /*Tree=*/true);
			}

			// Use IAssetTools::ExportAssets to export.
			IAssetTools& AT = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();

			TArray<UObject*> ObjectsToExport;
			ObjectsToExport.Add(MeshObject);

			// ExportAssets writes to the output directory.
			AT.ExportAssets(ObjectsToExport, OutputDir);

			// Check if the export file was created.
			const bool bExported = FPaths::FileExists(OutputFile);

			if (!bExported)
			{
				UE_LOG(LogTemp, Warning,
					TEXT("[MCPImportExport] export.mesh: expected output file not found at: %s"), *OutputFile);
			}

			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetStringField(TEXT("output_file"), OutputFile);
			Data->SetBoolField(TEXT("exported"), bExported);
			Data->SetStringField(TEXT("asset_class"), AssetClass);
			Data->SetStringField(TEXT("asset_path"), AssetPath);

			SendResponse(BuildImpSuccessResponse(CorrId, Data) + TEXT("\n"));
		});
	});

	// -----------------------------------------------------------------------
	// import.batch (IMP-04)
	// Batch imports all files matching given extensions from a directory.
	// Returns JSON with "assets" array, "count", "files_processed", "errors".
	// -----------------------------------------------------------------------
	Router.RegisterHandler(TEXT("import.batch"), [](TSharedPtr<FJsonObject> Cmd, FMCPResponseSender SendResponse)
	{
		const FString CorrId = Cmd->GetStringField(TEXT("correlationId"));

		// Extract payload.
		TSharedPtr<FJsonObject> Payload;
		const TSharedPtr<FJsonValue>* PayloadVal = Cmd->Values.Find(TEXT("payload"));
		if (PayloadVal && (*PayloadVal)->Type == EJson::Object)
		{
			Payload = (*PayloadVal)->AsObject();
		}

		FString Directory;
		FString DestPath;

		if (!Payload.IsValid()
			|| !Payload->TryGetStringField(TEXT("directory"), Directory) || Directory.IsEmpty()
			|| !Payload->TryGetStringField(TEXT("dest_path"), DestPath) || DestPath.IsEmpty())
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("missing_required_fields")) + TEXT("\n"));
			return;
		}

		// Validate directory path -- reject ".." (T-21-04).
		if (Directory.Contains(TEXT("..")))
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("invalid_directory_path")) + TEXT("\n"));
			return;
		}

		// Validate directory exists (T-21-04).
		if (!IFileManager::Get().DirectoryExists(*Directory))
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("directory_not_found")) + TEXT("\n"));
			return;
		}

		// Validate destination content path (T-21-03).
		if (!IsValidAssetPath(DestPath))
		{
			SendResponse(BuildImpErrorResponse(CorrId, TEXT("invalid_dest_path")) + TEXT("\n"));
			return;
		}

		// Extract extensions (default to ["fbx"]).
		TArray<FString> Extensions;
		const TArray<TSharedPtr<FJsonValue>>* ExtArray = nullptr;
		if (Payload->TryGetArrayField(TEXT("extensions"), ExtArray) && ExtArray)
		{
			for (const TSharedPtr<FJsonValue>& ExtVal : *ExtArray)
			{
				if (ExtVal.IsValid() && ExtVal->Type == EJson::String)
				{
					Extensions.Add(ExtVal->AsString().ToLower());
				}
			}
		}
		if (Extensions.IsEmpty())
		{
			Extensions.Add(TEXT("fbx"));
		}

		// Extract optional import settings.
		bool bImportMaterials = true;
		double ScaleFactor = 1.0;
		Payload->TryGetBoolField(TEXT("import_materials"), bImportMaterials);
		Payload->TryGetNumberField(TEXT("scale_factor"), ScaleFactor);

		AsyncTask(ENamedThreads::GameThread, [CorrId, SendResponse, Directory, DestPath, Extensions, bImportMaterials, ScaleFactor]()
		{
			// Enumerate all matching files in the directory.
			TArray<FString> FoundFiles;
			for (const FString& Ext : Extensions)
			{
				TArray<FString> FilesForExt;
				IFileManager::Get().FindFiles(FilesForExt, *(Directory / (TEXT("*.") + Ext)), /*Files=*/true, /*Dirs=*/false);
				for (const FString& FileName : FilesForExt)
				{
					FoundFiles.Add(Directory / FileName);
				}
			}

			const int32 FilesFound = FoundFiles.Num();

			// Build batch of UAssetImportTask objects.
			IAssetTools& AT = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();

			TArray<UAssetImportTask*> Tasks;
			TArray<TSharedPtr<FJsonValue>> ErrorsArray;

			for (const FString& SourceFile : FoundFiles)
			{
				// Per-file: derive asset name from file base name.
				const FString AssetName = FPaths::GetBaseFilename(SourceFile);

				UAssetImportTask* Task = NewObject<UAssetImportTask>();
				Task->Filename = SourceFile;
				Task->DestinationPath = DestPath;
				Task->DestinationName = AssetName;
				Task->bAutomated = true;
				Task->bReplaceExisting = true;
				Task->bSave = true;

				// For FBX files, use UFbxFactory with configured settings (via reflection).
				const FString FileExt = FPaths::GetExtension(SourceFile).ToLower();
				if (FileExt == TEXT("fbx"))
				{
					UObject* FbxFactory = CreateFbxFactory(bImportMaterials, /*bCombineMeshes=*/false, static_cast<float>(ScaleFactor));
					if (FbxFactory)
					{
						FObjectProperty* FactoryProp = CastField<FObjectProperty>(
							Task->GetClass()->FindPropertyByName(TEXT("Factory")));
						if (FactoryProp)
						{
							FactoryProp->SetObjectPropertyValue_InContainer(Task, FbxFactory);
						}
					}
				}
				// For other types, leave Factory null -- UE auto-detects.

				Tasks.Add(Task);
			}

			// Execute batch import.
			if (Tasks.Num() > 0)
			{
				AT.ImportAssetTasks(Tasks);
			}

			// Aggregate imported paths and errors.
			TArray<TSharedPtr<FJsonValue>> AssetsArray;
			for (UAssetImportTask* Task : Tasks)
			{
				if (Task)
				{
					for (const FString& ImportedPath : Task->ImportedObjectPaths)
					{
						AssetsArray.Add(MakeShared<FJsonValueString>(ImportedPath));
					}

					// If a task has no imported paths, record the source file as a failure.
					if (Task->ImportedObjectPaths.Num() == 0)
					{
						UE_LOG(LogTemp, Warning,
							TEXT("[MCPImportExport] import.batch: no assets imported from: %s"), *Task->Filename);
						ErrorsArray.Add(MakeShared<FJsonValueString>(
							FString::Printf(TEXT("no_assets_imported: %s"), *Task->Filename)));
					}
				}
			}

			TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
			Data->SetArrayField(TEXT("assets"), AssetsArray);
			Data->SetNumberField(TEXT("count"), static_cast<double>(AssetsArray.Num()));
			Data->SetNumberField(TEXT("files_processed"), static_cast<double>(FilesFound));
			Data->SetArrayField(TEXT("errors"), ErrorsArray);

			SendResponse(BuildImpSuccessResponse(CorrId, Data) + TEXT("\n"));
		});
	});
}
