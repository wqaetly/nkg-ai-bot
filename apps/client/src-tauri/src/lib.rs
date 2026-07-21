#[cfg(all(desktop, feature = "desktop-power"))]
mod runtime_sidecar;
mod runtime_tools;

#[cfg(all(desktop, feature = "desktop-power"))]
use runtime_sidecar::{runtime_sidecar_start, runtime_sidecar_stop, RuntimeSidecarState};
use runtime_tools::runtime_tool_call;
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
            runtime_tool_call,
            runtime_sidecar_start,
            runtime_sidecar_stop
        ]);

    #[cfg(all(desktop, not(feature = "desktop-power")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        runtime_platform,
        runtime_tool_call
    ]);

    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        runtime_platform,
        runtime_tool_call
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running NKG AI Bot");
}

#[cfg(test)]
mod migration_tests {
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
                "assistants",
                "conversations",
                "flows",
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
}
