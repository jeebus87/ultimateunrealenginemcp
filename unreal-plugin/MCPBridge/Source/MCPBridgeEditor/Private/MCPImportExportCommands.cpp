// MCPImportExportCommands.cpp
// Implements four asset import/export command handlers for the MCP bridge:
//   import.fbx    -- import an FBX file at a specified content path (IMP-01)
//   import.usd    -- import a USD file using the Interchange pipeline (IMP-02)
//   export.mesh   -- export a static or skeletal mesh to FBX format (IMP-03)
//   import.batch  -- batch import multiple files from a directory (IMP-04)
//
// All handlers dispatch via AsyncTask(ENamedThreads::GameThread, ...) since
// the router calls them off-thread.
// Call Modify() on any UObject before mutation operations (Pitfall 5).
// Validate source_file paths exist on disk before import (T-21-01, T-21-04).
// Validate asset_path starts with /Game/ or /Engine/ (T-21-03).
// Reject output_file paths containing ".." and validate .fbx extension (T-21-02).

#include "MCPImportExportCommands.h"

#include "Editor.h"
#include "Engine/World.h"

// Asset import/export APIs
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AssetImportTask.h"
#include "PackageName.h"

// FBX Factory and Export
#include "Factories/FbxFactory.h"
#include "Exporters/FbxExportOption.h"

// Interchange (USD import)
#include "InterchangeManager.h"

// Mesh types
#include "Engine/StaticMesh.h"
#include "Engine/SkeletalMesh.h"
#include "Exporters/Exporter.h"

// File system
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "HAL/FileManager.h"

// JSON
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
			// If DestPath ends without an asset name (e.g. /Game/Meshes/), derive
			// the asset name from the source file base name.
			FString PackagePath = DestPath;
			FString AssetName;

			// Check if the last component looks like an asset name (no trailing slash).
			if (DestPath.EndsWith(TEXT("/")))
			{
				// Directory-style dest_path: use source file base name as asset name.
				AssetName = FPaths::GetBaseFilename(SourceFile);
				PackagePath = DestPath.LeftChop(1); // remove trailing slash
			}
			else
			{
				AssetName = FPackageName::GetLongPackageAssetName(DestPath);
				PackagePath = FPackageName::GetLongPackagePath(DestPath);
				if (AssetName.IsEmpty())
				{
					// Treat as directory.
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

			// Create and configure UFbxFactory.
			UFbxFactory* FbxFactory = NewObject<UFbxFactory>();
			if (FbxFactory->ImportUI)
			{
				FbxFactory->ImportUI->bImportMaterials = bImportMaterials;
				FbxFactory->ImportUI->bCombineMeshes = bCombineMeshes;
				if (FbxFactory->ImportUI->StaticMeshImportData)
				{
					FbxFactory->ImportUI->StaticMeshImportData->ImportUniformScale = static_cast<float>(ScaleFactor);
				}
			}
			Task->Factory = FbxFactory;

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
			// Attempt Interchange import first.
			bool bInterchangeUsed = false;
			TArray<TSharedPtr<FJsonValue>> AssetsArray;

			if (GEditor && FModuleManager::Get().IsModuleLoaded(TEXT("InterchangeEngine")))
			{
				UInterchangeManager* InterchangeManager = UInterchangeManager::GetInterchangeManager();
				if (InterchangeManager)
				{
					// Use Interchange to import the USD file.
					// Set up import parameters with the destination path.
					UE::Interchange::FImportAssetParameters Params;
					Params.bIsAutomated = true;

					// Determine content path for Interchange. Normalize dest_path to directory.
					FString ContentDir = DestPath;
					if (!ContentDir.EndsWith(TEXT("/")))
					{
						// If it ends with what looks like an asset name, strip it.
						FString LastPart = FPackageName::GetLongPackageAssetName(ContentDir);
						if (!LastPart.IsEmpty())
						{
							ContentDir = FPackageName::GetLongPackagePath(ContentDir);
						}
					}
					Params.OverrideDestinationPath = ContentDir;

					InterchangeManager->ImportAsset(SourceFile, Params);

					// Interchange is async; we report success with empty assets list.
					// The engine will place assets at ContentDir when complete.
					bInterchangeUsed = true;

					UE_LOG(LogTemp, Log, TEXT("[MCPImportExport] import.usd: Interchange import initiated for: %s -> %s"), *SourceFile, *ContentDir);
				}
			}

			if (!bInterchangeUsed)
			{
				// Fallback: use UAssetImportTask (UE auto-detects USD factory).
				UE_LOG(LogTemp, Warning, TEXT("[MCPImportExport] import.usd: InterchangeEngine not available; falling back to UAssetImportTask for: %s"), *SourceFile);

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
				// No factory override — let UE auto-detect the USD factory.

				TArray<UAssetImportTask*> Tasks;
				Tasks.Add(Task);
				AT.ImportAssetTasks(Tasks);

				for (const FString& ImportedPath : Task->ImportedObjectPaths)
				{
					AssetsArray.Add(MakeShared<FJsonValueString>(ImportedPath));
				}
			}
			else
			{
				// Interchange initiated — report the method used.
				// Assets won't be available synchronously; report interchange_initiated.
				TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
				Data->SetArrayField(TEXT("assets"), AssetsArray);
				Data->SetNumberField(TEXT("count"), static_cast<double>(AssetsArray.Num()));
				Data->SetStringField(TEXT("method"), TEXT("interchange"));
				Data->SetBoolField(TEXT("async"), true);
				SendResponse(BuildImpSuccessResponse(CorrId, Data) + TEXT("\n"));
				return;
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

		// Validate output file — reject ".." (T-21-02) and require .fbx extension.
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
				UE_LOG(LogTemp, Warning, TEXT("[MCPImportExport] export.mesh: expected output file not found at: %s"), *OutputFile);
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

		// Validate directory path — reject ".." (T-21-04).
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

				// For FBX files, use UFbxFactory with configured settings.
				const FString FileExt = FPaths::GetExtension(SourceFile).ToLower();
				if (FileExt == TEXT("fbx"))
				{
					UFbxFactory* FbxFactory = NewObject<UFbxFactory>();
					if (FbxFactory->ImportUI)
					{
						FbxFactory->ImportUI->bImportMaterials = bImportMaterials;
						if (FbxFactory->ImportUI->StaticMeshImportData)
						{
							FbxFactory->ImportUI->StaticMeshImportData->ImportUniformScale = static_cast<float>(ScaleFactor);
						}
					}
					Task->Factory = FbxFactory;
				}
				// For other types, leave Factory null — UE auto-detects.

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
						UE_LOG(LogTemp, Warning, TEXT("[MCPImportExport] import.batch: no assets imported from: %s"), *Task->Filename);
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
