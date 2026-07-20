mod runtime_sidecar;

use runtime_sidecar::{runtime_sidecar_start, runtime_sidecar_stop, RuntimeSidecarState};
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
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
        })
        .manage(RuntimeSidecarState::default())
        .invoke_handler(tauri::generate_handler![
            runtime_platform,
            runtime_sidecar_start,
            runtime_sidecar_stop
        ])
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
                "roles"
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
}
