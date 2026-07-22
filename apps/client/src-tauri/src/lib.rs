#[cfg(all(desktop, feature = "desktop-power"))]
mod runtime_sidecar;
mod runtime_tools;

use rand::{rngs::OsRng, RngCore};
#[cfg(all(desktop, feature = "desktop-power"))]
use runtime_sidecar::{runtime_sidecar_start, runtime_sidecar_stop, RuntimeSidecarState};
use runtime_tools::runtime_tool_call;
use std::{fs::OpenOptions, io::Write, path::{Path, PathBuf}};
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

#[tauri::command]
fn runtime_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "unknown"
    }
}

const MIGRATION_PENDING_DIR: &str = "migration-pending";

#[tauri::command]
fn export_app_snapshot(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let local_data_dir = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "databaseHex": read_optional_hex(&data_dir.join("nkg-ai-bot.db"))?,
        "vaultHex": read_optional_hex(&data_dir.join("secrets-auto.hold"))?,
        "deviceKeyHex": read_optional_hex(&local_data_dir.join("vault-device.key"))?,
        "strongholdSaltHex": read_optional_hex(&local_data_dir.join("stronghold-salt"))?,
    }))
}

#[tauri::command]
fn save_migration_bundle(app: tauri::AppHandle, contents: String, filename: String) -> Result<String, String> {
    if contents.is_empty() || contents.len() > 128 * 1024 * 1024 {
        return Err("迁移包大小无效".to_string());
    }
    if filename.len() > 180
        || !filename.ends_with(".nkgbackup")
        || filename.contains(['/', '\\'])
        || filename.contains("..")
    {
        return Err("迁移文件名无效".to_string());
    }
    let download_dir = app.path().download_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&download_dir).map_err(|error| error.to_string())?;
    let target = unique_download_path(&download_dir, &filename);
    std::fs::write(&target, contents.as_bytes()).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn stage_app_import(
    app: tauri::AppHandle,
    database_hex: String,
    vault_hex: Option<String>,
    device_key_hex: Option<String>,
    stronghold_salt_hex: Option<String>,
) -> Result<(), String> {
    if database_hex.is_empty() {
        return Err("迁移包缺少应用数据库".to_string());
    }
    let local_data_dir = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
    let pending_dir = local_data_dir.join(MIGRATION_PENDING_DIR);
    if pending_dir.exists() {
        std::fs::remove_dir_all(&pending_dir).map_err(|error| error.to_string())?;
    }
    std::fs::create_dir_all(&pending_dir).map_err(|error| error.to_string())?;
    write_hex_file(&pending_dir.join("nkg-ai-bot.db"), &database_hex)?;
    write_optional_hex_file(&pending_dir.join("secrets-auto.hold"), vault_hex.as_deref())?;
    write_optional_hex_file(&pending_dir.join("vault-device.key"), device_key_hex.as_deref())?;
    write_optional_hex_file(&pending_dir.join("stronghold-salt"), stronghold_salt_hex.as_deref())?;
    std::fs::write(pending_dir.join("ready"), b"nkg-migration-v1")
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_local_first_schema",
            sql: include_str!("../migrations/0001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "touch_conversation_after_message_insert",
            sql: include_str!("../migrations/0002_message_touch_trigger.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create_runtime_persistence_schema",
            sql: include_str!("../migrations/0003_runtime_persistence.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create_local_learning_schema",
            sql: include_str!("../migrations/0004_local_learning.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "create_resumable_learning_jobs",
            sql: include_str!("../migrations/0005_learning_jobs.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "create_versioned_assistant_skills",
            sql: include_str!("../migrations/0006_assistant_skills.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "create_local_evaluation_pipeline",
            sql: include_str!("../migrations/0007_evaluation.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "add_provider_model_catalog_and_conversation_model",
            sql: include_str!("../migrations/0008_provider_models.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "add_skill_scoped_conversation_groups",
            sql: include_str!("../migrations/0009_conversation_groups.sql"),
            kind: MigrationKind::Up,
        },
    ];

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:nkg-ai-bot.db", migrations)
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            apply_pending_import(app.handle()).map_err(std::io::Error::other)?;
            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                window.set_zoom(1.0)?;
            }
            app.handle().plugin(
                tauri_plugin_stronghold::Builder::with_argon2(&data_dir.join("stronghold-salt"))
                    .build(),
            )?;
            Ok(())
        });

    #[cfg(all(desktop, feature = "desktop-power"))]
    let builder = builder
        .plugin(tauri_plugin_shell::init())
        .manage(RuntimeSidecarState::default())
        .invoke_handler(tauri::generate_handler![
            runtime_platform,
            secret_vault_device_password,
            export_app_snapshot,
            save_migration_bundle,
            stage_app_import,
            restart_app,
            runtime_tool_call,
            runtime_sidecar_start,
            runtime_sidecar_stop
        ]);

    #[cfg(all(desktop, not(feature = "desktop-power")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        runtime_platform,
        secret_vault_device_password,
        export_app_snapshot,
        save_migration_bundle,
        stage_app_import,
        restart_app,
        runtime_tool_call
    ]);

    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        runtime_platform,
        secret_vault_device_password,
        export_app_snapshot,
        save_migration_bundle,
        stage_app_import,
        restart_app,
        runtime_tool_call
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running NKG AI Bot");
}

fn apply_pending_import(app: &tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let local_data_dir = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
    let pending_dir = local_data_dir.join(MIGRATION_PENDING_DIR);
    if !pending_dir.join("ready").exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&local_data_dir).map_err(|error| error.to_string())?;
    replace_from_pending(&pending_dir.join("nkg-ai-bot.db"), &data_dir.join("nkg-ai-bot.db"))?;
    replace_optional_from_pending(&pending_dir.join("secrets-auto.hold"), &data_dir.join("secrets-auto.hold"))?;
    replace_optional_from_pending(&pending_dir.join("vault-device.key"), &local_data_dir.join("vault-device.key"))?;
    replace_optional_from_pending(&pending_dir.join("stronghold-salt"), &local_data_dir.join("stronghold-salt"))?;
    for sidecar in [data_dir.join("nkg-ai-bot.db-wal"), data_dir.join("nkg-ai-bot.db-shm")] {
        if sidecar.exists() {
            std::fs::remove_file(sidecar).map_err(|error| error.to_string())?;
        }
    }
    std::fs::remove_dir_all(pending_dir).map_err(|error| error.to_string())?;
    Ok(())
}

fn replace_from_pending(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err(format!("待导入文件缺失：{}", source.display()));
    }
    let temporary = temporary_target(target);
    std::fs::copy(source, &temporary).map_err(|error| error.to_string())?;
    if target.exists() {
        std::fs::remove_file(target).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temporary, target).map_err(|error| error.to_string())?;
    Ok(())
}

fn replace_optional_from_pending(source: &Path, target: &Path) -> Result<(), String> {
    if source.exists() {
        replace_from_pending(source, target)
    } else {
        if target.exists() {
            std::fs::remove_file(target).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

fn temporary_target(target: &Path) -> PathBuf {
    let mut value = target.as_os_str().to_os_string();
    value.push(".migration-tmp");
    PathBuf::from(value)
}

fn unique_download_path(directory: &Path, filename: &str) -> PathBuf {
    let initial = directory.join(filename);
    if !initial.exists() {
        return initial;
    }
    let stem = filename.strip_suffix(".nkgbackup").unwrap_or(filename);
    for index in 1..10_000 {
        let candidate = directory.join(format!("{stem} ({index}).nkgbackup"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}-{}.nkgbackup", std::process::id()))
}

fn read_optional_hex(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(Some(encode_hex(&bytes)))
}

fn write_optional_hex_file(path: &Path, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => write_hex_file(path, value),
        None => Ok(()),
    }
}

fn write_hex_file(path: &Path, value: &str) -> Result<(), String> {
    let bytes = decode_hex(value)?;
    std::fs::write(path, bytes).map_err(|error| error.to_string())
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("迁移包包含无效的二进制数据".to_string());
    }
    value.as_bytes().chunks_exact(2).map(|pair| {
        let pair = std::str::from_utf8(pair).map_err(|error| error.to_string())?;
        u8::from_str_radix(pair, 16).map_err(|error| error.to_string())
    }).collect()
}

#[cfg(test)]
mod migration_tests {
    use super::generate_device_secret;
    use sqlx::{sqlite::SqlitePoolOptions, Row};

    #[tokio::test]
    async fn local_schema_and_message_trigger_apply_atomically() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        sqlx::raw_sql(include_str!("../migrations/0001_initial.sql"))
            .execute(&pool)
            .await
            .expect("apply initial migration");
        sqlx::raw_sql(include_str!("../migrations/0002_message_touch_trigger.sql"))
            .execute(&pool)
            .await
            .expect("apply trigger migration");
        sqlx::raw_sql(include_str!("../migrations/0003_runtime_persistence.sql"))
            .execute(&pool)
            .await
            .expect("apply runtime persistence migration");
        sqlx::raw_sql(include_str!("../migrations/0004_local_learning.sql"))
            .execute(&pool)
            .await
            .expect("apply local learning migration");
        sqlx::raw_sql(include_str!("../migrations/0005_learning_jobs.sql"))
            .execute(&pool)
            .await
            .expect("apply learning jobs migration");
        sqlx::raw_sql(include_str!("../migrations/0006_assistant_skills.sql"))
            .execute(&pool)
            .await
            .expect("apply assistant skills migration");
        sqlx::raw_sql(include_str!("../migrations/0007_evaluation.sql"))
            .execute(&pool)
            .await
            .expect("apply evaluation migration");
        sqlx::raw_sql(include_str!("../migrations/0008_provider_models.sql"))
            .execute(&pool)
            .await
            .expect("apply provider models migration");
        sqlx::raw_sql(include_str!("../migrations/0009_conversation_groups.sql"))
            .execute(&pool)
            .await
            .expect("apply legacy conversation groups migration");

        let tables: Vec<String> = sqlx::query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .fetch_all(&pool)
            .await
            .expect("list tables")
            .into_iter()
            .map(|row| row.get("name"))
            .collect();
        assert_eq!(
            tables,
            vec![
                "app_settings",
                "artifact_candidates",
                "assistant_active",
                "assistant_run_links",
                "assistant_skill_usage",
                "assistant_versions",
                "assistants",
                "conversation_groups",
                "conversations",
                "eval_case_results",
                "eval_cases",
                "eval_runs",
                "flows",
                "learning_candidates",
                "learning_jobs",
                "memory_items",
                "message_feedback",
                "messages",
                "provider_profiles",
                "roles",
                "runtime_events",
                "runtime_flow_active",
                "runtime_flow_artifacts",
                "runtime_flow_registry",
                "runtime_runs",
                "runtime_variables"
            ]
        );

        sqlx::query(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', '', 1, 1)",
        )
        .execute(&pool)
        .await
        .expect("insert conversation");
        sqlx::query("INSERT INTO messages (id, conversation_id, sequence, role, content_json, created_at) VALUES ('m1', 'c1', 0, 'user', '{}', 42)")
            .execute(&pool).await.expect("insert message");
        let updated_at: i64 =
            sqlx::query_scalar("SELECT updated_at FROM conversations WHERE id='c1'")
                .fetch_one(&pool)
                .await
                .expect("read touched timestamp");
        assert_eq!(updated_at, 42);

        let foreign_key_violations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                .fetch_one(&pool)
                .await
                .expect("foreign key check");
        assert_eq!(foreign_key_violations, 0);
    }

    #[tokio::test]
    async fn runtime_schema_enforces_json_status_and_event_ownership() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        sqlx::raw_sql(include_str!("../migrations/0001_initial.sql"))
            .execute(&pool)
            .await
            .expect("apply initial migration");
        sqlx::raw_sql(include_str!("../migrations/0002_message_touch_trigger.sql"))
            .execute(&pool)
            .await
            .expect("apply trigger migration");
        sqlx::raw_sql(include_str!("../migrations/0003_runtime_persistence.sql"))
            .execute(&pool)
            .await
            .expect("apply runtime persistence migration");
        sqlx::raw_sql(include_str!("../migrations/0004_local_learning.sql"))
            .execute(&pool)
            .await
            .expect("apply local learning migration");
        sqlx::raw_sql(include_str!("../migrations/0005_learning_jobs.sql"))
            .execute(&pool)
            .await
            .expect("apply learning jobs migration");
        sqlx::raw_sql(include_str!("../migrations/0006_assistant_skills.sql"))
            .execute(&pool)
            .await
            .expect("apply assistant skills migration");

        sqlx::query("INSERT INTO runtime_runs (run_id, flow_id, status, created_at, record_json) VALUES ('r1', 'f1', 'queued', '2026-01-01T00:00:00.000Z', '{}')")
            .execute(&pool)
            .await
            .expect("insert runtime run");
        sqlx::query("INSERT INTO runtime_events (run_id, event_sequence, flow_id, flow_version, node_sequence, timestamp, kind, payload_json) VALUES ('r1', 1, 'f1', '1.0.0', 1, '2026-01-01T00:00:00.000Z', 'run_started', '{}')")
            .execute(&pool)
            .await
            .expect("insert owned event");

        let next_event_sequence: i64 = sqlx::query_scalar(
            "INSERT INTO runtime_events
               (run_id, event_sequence, flow_id, flow_version, node_sequence, timestamp, kind, payload_json)
             SELECT $1, COALESCE(MAX(event_sequence), 0) + 1, $2, $3, $4, $5, $6, $7
               FROM runtime_events WHERE run_id = $1
             RETURNING event_sequence",
        )
        .bind("r1")
        .bind("f1")
        .bind("1.0.0")
        .bind(2_i64)
        .bind("2026-01-01T00:00:01.000Z")
        .bind("run_finished")
        .bind("{}")
        .fetch_one(&pool)
        .await
        .expect("atomically allocate event cursor");
        assert_eq!(next_event_sequence, 2);

        sqlx::query("INSERT INTO runtime_flow_registry (flow_id, version, artifact_hash, status, graph_json, registered_at) VALUES ('f1', '1.0.0', 'h1', 'staging', '{}', '2026-01-01T00:00:00.000Z'), ('f1', '2.0.0', 'h2', 'staging', '{}', '2026-01-01T00:00:01.000Z')")
            .execute(&pool)
            .await
            .expect("register runtime flow versions");
        let first_previous: Option<String> = sqlx::query_scalar(
            "INSERT INTO runtime_flow_active (flow_id, active_version, previous_version, updated_at)
             VALUES ($1, $2, NULL, $3)
             ON CONFLICT(flow_id) DO UPDATE SET
               previous_version = CASE
                 WHEN runtime_flow_active.active_version <> excluded.active_version
                 THEN runtime_flow_active.active_version ELSE NULL END,
               active_version = excluded.active_version,
               updated_at = excluded.updated_at
             RETURNING previous_version",
        )
        .bind("f1")
        .bind("1.0.0")
        .bind("2026-01-01T00:00:02.000Z")
        .fetch_one(&pool)
        .await
        .expect("promote initial flow version");
        assert_eq!(first_previous, None);
        let second_previous: Option<String> = sqlx::query_scalar(
            "INSERT INTO runtime_flow_active (flow_id, active_version, previous_version, updated_at)
             VALUES ($1, $2, NULL, $3)
             ON CONFLICT(flow_id) DO UPDATE SET
               previous_version = CASE
                 WHEN runtime_flow_active.active_version <> excluded.active_version
                 THEN runtime_flow_active.active_version ELSE NULL END,
               active_version = excluded.active_version,
               updated_at = excluded.updated_at
             RETURNING previous_version",
        )
        .bind("f1")
        .bind("2.0.0")
        .bind("2026-01-01T00:00:03.000Z")
        .fetch_one(&pool)
        .await
        .expect("atomically replace active flow version");
        assert_eq!(second_previous.as_deref(), Some("1.0.0"));
        let promoted_statuses: Vec<(String, String)> = sqlx::query_as(
            "SELECT version, status FROM runtime_flow_registry WHERE flow_id = 'f1' ORDER BY version",
        )
        .fetch_all(&pool)
        .await
        .expect("read trigger-updated registry statuses");
        assert_eq!(
            promoted_statuses,
            vec![
                ("1.0.0".to_string(), "draining".to_string()),
                ("2.0.0".to_string(), "active".to_string())
            ]
        );

        sqlx::query("UPDATE runtime_runs SET record_json = json_set(json_set(record_json, '$.status', json($1)), '$.output', json($2)), status = $3 WHERE run_id = $4")
            .bind(r#""succeeded""#)
            .bind("null")
            .bind("succeeded")
            .bind("r1")
            .execute(&pool)
            .await
            .expect("atomically patch runtime run");
        let (patched_status, output_type): (String, String) =
            sqlx::query_as("SELECT status, json_type(record_json, '$.output') FROM runtime_runs WHERE run_id = 'r1'")
                .fetch_one(&pool)
                .await
                .expect("read patched run status");
        assert_eq!(patched_status, "succeeded");
        assert_eq!(output_type, "null");

        assert!(sqlx::query("INSERT INTO runtime_runs (run_id, flow_id, status, created_at, record_json) VALUES ('bad-status', 'f1', 'unknown', 'now', '{}')")
            .execute(&pool).await.is_err());
        assert!(sqlx::query("INSERT INTO runtime_variables (name, value_json, updated_at) VALUES ('bad-json', 'not-json', 'now')")
            .execute(&pool).await.is_err());
        assert!(sqlx::query("INSERT INTO runtime_events (run_id, event_sequence, flow_id, flow_version, node_sequence, timestamp, kind, payload_json) VALUES ('missing', 1, 'f1', '1.0.0', 1, 'now', 'run_started', '{}')")
            .execute(&pool).await.is_err());
    }

    #[tokio::test]
    async fn provider_model_migration_clears_legacy_configuration_and_enforces_selection() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        sqlx::raw_sql(include_str!("../migrations/0001_initial.sql"))
            .execute(&pool)
            .await
            .expect("apply initial migration");
        sqlx::query("INSERT INTO provider_profiles (id, name, base_url, default_model, api_key_ref, created_at, updated_at) VALUES ('legacy', 'Legacy', 'https://example.test/v1', 'old-model', 'old-key', 1, 1)")
            .execute(&pool).await.expect("seed legacy provider");
        sqlx::query("INSERT INTO app_settings (key, value_json, updated_at) VALUES ('selected_provider_id', '\"legacy\"', 1)")
            .execute(&pool).await.expect("seed legacy selection");

        sqlx::raw_sql(include_str!("../migrations/0008_provider_models.sql"))
            .execute(&pool)
            .await
            .expect("apply provider model migration");

        let providers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM provider_profiles")
            .fetch_one(&pool)
            .await
            .expect("count providers");
        let selection: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM app_settings WHERE key='selected_provider_id'",
        )
        .fetch_one(&pool)
        .await
        .expect("count selections");
        assert_eq!(providers, 0);
        assert_eq!(selection, 0);

        sqlx::query("INSERT INTO conversations (id, title, provider_id, model_id, created_at, updated_at) VALUES ('valid', '', 'openai', 'model-a', 1, 1)")
            .execute(&pool).await.expect("insert provider-bound conversation");
        assert!(sqlx::query("INSERT INTO conversations (id, title, model_id, created_at, updated_at) VALUES ('invalid', '', 'model-a', 1, 1)")
            .execute(&pool).await.is_err());
    }

    #[test]
    fn generated_device_secrets_are_random_hex_values() {
        let first = generate_device_secret();
        let second = generate_device_secret();
        assert_eq!(first.len(), 96);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[tokio::test]
    async fn local_learning_schema_keeps_candidates_reviewable_and_memories_bounded() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        for migration in [
            include_str!("../migrations/0001_initial.sql"),
            include_str!("../migrations/0002_message_touch_trigger.sql"),
            include_str!("../migrations/0003_runtime_persistence.sql"),
            include_str!("../migrations/0004_local_learning.sql"),
            include_str!("../migrations/0005_learning_jobs.sql"),
            include_str!("../migrations/0006_assistant_skills.sql"),
            include_str!("../migrations/0007_evaluation.sql"),
            include_str!("../migrations/0008_provider_models.sql"),
        ] {
            sqlx::raw_sql(migration)
                .execute(&pool)
                .await
                .expect("apply migration");
        }

        sqlx::query("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', '', 1, 1)")
            .execute(&pool).await.expect("insert conversation");
        sqlx::query("INSERT INTO messages (id, conversation_id, sequence, role, content_json, created_at) VALUES ('m1', 'c1', 0, 'user', '\"用户喜欢蓝色\"', 2)")
            .execute(&pool).await.expect("insert source message");
        sqlx::query("INSERT INTO learning_candidates (id, kind, source_message_id, source_conversation_id, proposal_json, status, created_at, updated_at) VALUES ('candidate-1', 'memory_fact', 'm1', 'c1', '{\"content\":\"用户喜欢蓝色\",\"confidence\":1}', 'pending', 3, 3)")
            .execute(&pool).await.expect("insert reviewable candidate");
        sqlx::query("INSERT INTO memory_items (id, content, content_key, source_message_id, confidence, status, created_at, updated_at) VALUES ('memory-1', '用户喜欢蓝色', '用户喜欢蓝色', 'm1', 1, 'active', 4, 4)")
            .execute(&pool).await.expect("insert approved memory");
        sqlx::query("INSERT INTO message_feedback (id, message_id, conversation_id, rating, created_at, updated_at) VALUES ('feedback-1', 'm1', 'c1', 'positive', 5, 5)")
            .execute(&pool).await.expect("insert message feedback");
        sqlx::query("INSERT INTO learning_jobs (id, type, source_conversation_id, source_message_id, status, checkpoint_json, created_at, updated_at) VALUES ('job-1', 'reflection', 'c1', 'm1', 'running', '{\"phase\":\"running\"}', 6, 6)")
            .execute(&pool).await.expect("insert resumable learning job");
        sqlx::query("INSERT INTO learning_candidates (id, kind, source_message_id, source_conversation_id, job_id, proposal_json, status, created_at, updated_at) VALUES ('candidate-2', 'memory_fact', 'm1', 'c1', 'job-1', '{\"content\":\"用户喜欢蓝色\",\"confidence\":1}', 'pending', 7, 7)")
            .execute(&pool).await.expect("link candidate to learning job");

        assert!(sqlx::query("INSERT INTO memory_items (id, content, content_key, confidence, status, created_at, updated_at) VALUES ('bad-confidence', 'bad', 'bad', 2, 'active', 1, 1)")
            .execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE learning_candidates SET status='applied-without-review' WHERE id='candidate-1'")
            .execute(&pool).await.is_err());
        assert!(sqlx::query("INSERT INTO message_feedback (id, message_id, conversation_id, rating, created_at, updated_at) VALUES ('bad-feedback', 'missing', 'c1', 'positive', 1, 1)")
            .execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE learning_jobs SET status='unknown' WHERE id='job-1'")
            .execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE learning_jobs SET checkpoint_json='not-json' WHERE id='job-1'")
            .execute(&pool).await.is_err());
        sqlx::query("UPDATE learning_jobs SET status='interrupted', checkpoint_json='{\"phase\":\"interrupted\"}', runtime_run_id=NULL, updated_at=8 WHERE status='running'")
            .execute(&pool).await.expect("recover abandoned running job");
        let recovered: String = sqlx::query_scalar("SELECT status FROM learning_jobs WHERE id='job-1'")
            .fetch_one(&pool).await.expect("read recovered job");
        assert_eq!(recovered, "interrupted");
        let foreign_key_violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(&pool).await.expect("check learning foreign keys");
        assert_eq!(foreign_key_violations, 0);
    }

    #[tokio::test]
    async fn assistant_skills_are_immutable_versioned_and_traceable() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        for migration in [
            include_str!("../migrations/0001_initial.sql"),
            include_str!("../migrations/0002_message_touch_trigger.sql"),
            include_str!("../migrations/0003_runtime_persistence.sql"),
            include_str!("../migrations/0004_local_learning.sql"),
            include_str!("../migrations/0005_learning_jobs.sql"),
            include_str!("../migrations/0006_assistant_skills.sql"),
            include_str!("../migrations/0007_evaluation.sql"),
            include_str!("../migrations/0008_provider_models.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.expect("apply migration");
        }

        sqlx::query("INSERT INTO flows (id, version, name, graph_json, created_at, updated_at) VALUES ('chat', '1.0.0', 'Chat', '{}', 1, 1), ('chat', '2.0.0', 'Chat v2', '{}', 2, 2)")
            .execute(&pool).await.expect("insert flow versions");
        sqlx::query("INSERT INTO assistants (id, name, description, flow_id, flow_version, created_at, updated_at) VALUES ('assistant', 'Assistant', '', 'chat', '1.0.0', 1, 1)")
            .execute(&pool).await.expect("insert assistant identity");
        sqlx::query("INSERT INTO assistant_versions (assistant_id, version, name, system_prompt, flow_id, flow_version, capabilities_json, activation_hints_json, created_at) VALUES ('assistant', '1.0.0', 'Assistant', 'Prompt v1', 'chat', '1.0.0', '[]', '[]', 1), ('assistant', '2.0.0', 'Assistant', 'Prompt v2', 'chat', '2.0.0', '[]', '[]', 2)")
            .execute(&pool).await.expect("insert immutable assistant versions");
        assert!(sqlx::query("UPDATE assistant_versions SET system_prompt='mutated' WHERE assistant_id='assistant' AND version='1.0.0'")
            .execute(&pool).await.is_err());

        sqlx::query("INSERT INTO assistant_active (assistant_id, active_version, previous_version, pinned, updated_at) VALUES ('assistant', '1.0.0', NULL, 1, 3)")
            .execute(&pool).await.expect("activate first version");
        sqlx::query("UPDATE assistant_active SET previous_version=active_version, active_version='2.0.0', updated_at=4 WHERE assistant_id='assistant'")
            .execute(&pool).await.expect("promote second version");
        let pointer: (String, Option<String>) = sqlx::query_as("SELECT active_version, previous_version FROM assistant_active WHERE assistant_id='assistant'")
            .fetch_one(&pool).await.expect("read assistant pointers");
        assert_eq!(pointer, ("2.0.0".to_string(), Some("1.0.0".to_string())));

        sqlx::query("INSERT INTO assistant_skill_usage (assistant_id, assistant_version, use_count, success_count, failure_count, updated_at) VALUES ('assistant', '2.0.0', 1, 1, 0, 5)")
            .execute(&pool).await.expect("insert usage counters");
        sqlx::query("INSERT INTO conversations (id, title, assistant_id, assistant_version, created_at, updated_at) VALUES ('c-skill', '', 'assistant', '2.0.0', 5, 5)")
            .execute(&pool).await.expect("bind conversation version");
        assert!(sqlx::query("INSERT INTO conversations (id, title, assistant_id, assistant_version, created_at, updated_at) VALUES ('c-bad', '', 'assistant', '9.9.9', 5, 5)")
            .execute(&pool).await.is_err());
        sqlx::query("INSERT INTO messages (id, conversation_id, sequence, role, content_json, created_at) VALUES ('m-user', 'c-skill', 0, 'user', '\"hello\"', 6), ('m-assistant', 'c-skill', 1, 'assistant', '\"hi\"', 7)")
            .execute(&pool).await.expect("insert linked messages");
        sqlx::query("INSERT INTO assistant_run_links (id, runtime_run_id, conversation_id, user_message_id, assistant_message_id, assistant_id, assistant_version, flow_id, flow_version, status, created_at, updated_at, completed_at) VALUES ('link-1', 'run-1', 'c-skill', 'm-user', 'm-assistant', 'assistant', '2.0.0', 'chat', '2.0.0', 'succeeded', 6, 7, 7)")
            .execute(&pool).await.expect("link trajectory to assistant version");
        assert!(sqlx::query("INSERT INTO assistant_run_links (id, conversation_id, user_message_id, assistant_id, assistant_version, flow_id, flow_version, status, created_at, updated_at) VALUES ('link-bad', 'c-skill', 'm-user', 'assistant', '2.0.0', 'chat', '1.0.0', 'running', 6, 6)")
            .execute(&pool).await.is_err());

        sqlx::query("INSERT INTO eval_cases (id, assistant_id, assistant_version, input_json, assertions_json, source, enabled, created_at, updated_at) VALUES ('case-1', 'assistant', '2.0.0', '\"hello\"', '{\"mustContain\":[\"hi\"]}', 'golden', 1, 8, 8)")
            .execute(&pool).await.expect("insert frozen eval case");
        sqlx::query("INSERT INTO artifact_candidates (id, kind, assistant_id, base_version, proposed_version, proposal_json, status, created_at, updated_at) VALUES ('candidate-prompt', 'assistant_prompt_patch', 'assistant', '2.0.0', '2.0.1', '{\"systemPrompt\":\"Better\"}', 'pending', 9, 9)")
            .execute(&pool).await.expect("insert artifact candidate");
        assert!(sqlx::query("UPDATE artifact_candidates SET status='published' WHERE id='candidate-prompt'")
            .execute(&pool).await.is_err());
        sqlx::query("INSERT INTO eval_runs (id, candidate_id, status, baseline_score, candidate_score, gates_json, summary_json, created_at, updated_at, completed_at) VALUES ('eval-1', 'candidate-prompt', 'passed', 0.5, 1.0, '[{\"id\":\"regression\",\"passed\":true}]', '{}', 10, 11, 11)")
            .execute(&pool).await.expect("insert completed evaluation");
        sqlx::query("INSERT INTO eval_case_results (eval_run_id, case_id, variant, status, output_text, score, assertions_json, created_at) VALUES ('eval-1', 'case-1', 'baseline', 'succeeded', 'hello', 0.5, '[]', 10), ('eval-1', 'case-1', 'candidate', 'succeeded', 'hi', 1.0, '[]', 10)")
            .execute(&pool).await.expect("insert paired evaluation results");
        sqlx::query("UPDATE artifact_candidates SET status='passed', latest_eval_run_id='eval-1' WHERE id='candidate-prompt'")
            .execute(&pool).await.expect("pass evaluated candidate");
        sqlx::query("UPDATE artifact_candidates SET status='published' WHERE id='candidate-prompt'")
            .execute(&pool).await.expect("publish only after pass");

        let foreign_key_violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(&pool).await.expect("check assistant foreign keys");
        assert_eq!(foreign_key_violations, 0);
    }
}

#[tauri::command]
fn secret_vault_device_password(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let key_path = data_dir.join("vault-device.key");
    if key_path.exists() {
        if let Ok(secret) = read_device_secret(&key_path) {
            return Ok(secret);
        }
        std::fs::remove_file(&key_path).map_err(|error| error.to_string())?;
    }

    let vault_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    // The legacy password snapshot and any orphaned automatic snapshot cannot be
    // opened with the newly generated key, so this release intentionally resets both.
    for snapshot in [vault_dir.join("secrets.hold"), vault_dir.join("secrets-auto.hold")] {
        if snapshot.exists() {
            std::fs::remove_file(snapshot).map_err(|error| error.to_string())?;
        }
    }

    let secret = generate_device_secret();
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&key_path)
    {
        Ok(mut file) => {
            file.write_all(secret.as_bytes())
                .map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            restrict_device_secret_permissions(&key_path)?;
            Ok(secret)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_device_secret(&key_path)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn generate_device_secret() -> String {
    let mut bytes = [0_u8; 48];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_device_secret(path: &std::path::Path) -> Result<String, String> {
    let value = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value = value.trim().to_owned();
    if value.len() < 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("设备密钥文件无效".to_string());
    }
    Ok(value)
}

#[cfg(unix)]
fn restrict_device_secret_permissions(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn restrict_device_secret_permissions(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}
