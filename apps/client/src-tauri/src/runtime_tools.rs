use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

const READ_ONLY_TOOLS: [&str; 3] = ["list_files", "read_file", "grep"];
const MAX_FILES: usize = 2_000;

#[tauri::command]
pub fn runtime_tool_call(app: tauri::AppHandle, call: Value, policy: Value) -> Value {
    match execute(&app, &call, &policy) {
        Ok(output) => json!({ "ok": true, "output": output }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn execute(app: &tauri::AppHandle, call: &Value, policy: &Value) -> Result<Value, String> {
    let tool = required_string(call, "tool")?;
    let allowed = policy
        .get("allowedTools")
        .and_then(Value::as_array)
        .ok_or_else(|| "allowedTools policy is required".to_string())?;
    if !READ_ONLY_TOOLS.contains(&tool)
        || !allowed.iter().any(|item| item.as_str() == Some(tool))
    {
        return Err(format!("tool {tool} is not allowed by the native runtime"));
    }

    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("resolve app data directory: {error}"))?
        .join("tool-workspace");
    fs::create_dir_all(&root).map_err(|error| format!("create tool workspace: {error}"))?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("open tool workspace: {error}"))?;
    let args = call
        .get("args")
        .and_then(Value::as_object)
        .ok_or_else(|| "tool args must be an object".to_string())?;
    let max_chars = policy
        .get("maxOutputChars")
        .and_then(Value::as_u64)
        .unwrap_or(20_000)
        .clamp(512, 200_000) as usize;

    match tool {
        "list_files" => list_files(&root, args, max_chars),
        "read_file" => read_file(&root, args, max_chars),
        "grep" => grep_files(&root, args, max_chars),
        _ => Err("unsupported tool".to_string()),
    }
}

fn list_files(root: &Path, args: &Map<String, Value>, max_chars: usize) -> Result<Value, String> {
    let target = confined_existing_path(root, optional_string(args, "path").unwrap_or(""))?;
    if !target.is_dir() {
        return Err("list_files path is not a directory".to_string());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(target).map_err(display_io)? {
        let entry = entry.map_err(display_io)?;
        if entry.file_type().map_err(display_io)?.is_symlink() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| "path escaped tool workspace".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(relative);
    }
    entries.sort();
    Ok(Value::Array(truncate_values(entries, max_chars)))
}

fn read_file(root: &Path, args: &Map<String, Value>, max_chars: usize) -> Result<Value, String> {
    let path = confined_existing_path(root, required_map_string(args, "path")?)?;
    if !path.is_file() {
        return Err("read_file path is not a file".to_string());
    }
    let text = fs::read_to_string(path).map_err(display_io)?;
    Ok(Value::String(truncate_text(&text, max_chars)))
}

fn grep_files(root: &Path, args: &Map<String, Value>, max_chars: usize) -> Result<Value, String> {
    let pattern = required_map_string(args, "pattern")?;
    if pattern.is_empty() {
        return Err("grep pattern cannot be empty".to_string());
    }
    let target = confined_existing_path(root, optional_string(args, "path").unwrap_or(""))?;
    let mut files = Vec::new();
    collect_files(&target, &mut files)?;
    let mut matches = Vec::new();
    let mut output_chars = 0usize;
    for file in files.into_iter().take(MAX_FILES) {
        let canonical = file.canonicalize().map_err(display_io)?;
        if !canonical.starts_with(root) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&canonical) else {
            continue;
        };
        let relative = canonical
            .strip_prefix(root)
            .map_err(|_| "path escaped tool workspace".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        for (index, line) in text.lines().enumerate() {
            if line.contains(pattern) {
                let item = format!("{relative}:{}:{line}", index + 1);
                output_chars += item.chars().count();
                if output_chars > max_chars {
                    return Ok(Value::Array(matches));
                }
                matches.push(Value::String(item));
            }
        }
    }
    Ok(Value::Array(matches))
}

fn collect_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if files.len() >= MAX_FILES {
        return Ok(());
    }
    if path.is_file() {
        files.push(path.to_path_buf());
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(display_io)? {
        let entry = entry.map_err(display_io)?;
        let file_type = entry.file_type().map_err(display_io)?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_files(&entry.path(), files)?;
        } else if file_type.is_file() {
            files.push(entry.path());
        }
        if files.len() >= MAX_FILES {
            break;
        }
    }
    Ok(())
}

fn confined_existing_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = sanitize_relative_path(relative)?;
    let canonical = root.join(relative).canonicalize().map_err(display_io)?;
    if !canonical.starts_with(root) {
        return Err("path escaped tool workspace".to_string());
    }
    Ok(canonical)
}

fn sanitize_relative_path(value: &str) -> Result<PathBuf, String> {
    let normalized = value.replace('\\', "/");
    let path = Path::new(&normalized);
    let has_windows_drive = normalized.as_bytes().get(1) == Some(&b':')
        && normalized.as_bytes()[0].is_ascii_alphabetic();
    if path.is_absolute() || has_windows_drive {
        return Err("absolute paths are not allowed".to_string());
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => clean.push(segment),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("parent and rooted paths are not allowed".to_string());
            }
        }
    }
    Ok(clean)
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))
}

fn required_map_string<'a>(
    value: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))
}

fn optional_string<'a>(value: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

fn truncate_values(values: Vec<String>, max_chars: usize) -> Vec<Value> {
    let mut used = 0usize;
    values
        .into_iter()
        .take_while(|value| {
            used += value.chars().count();
            used <= max_chars
        })
        .map(Value::String)
        .collect()
}

fn display_io(error: std::io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::sanitize_relative_path;

    #[test]
    fn accepts_only_relative_paths_without_parent_segments() {
        assert_eq!(sanitize_relative_path("notes/readme.md").unwrap(), std::path::PathBuf::from("notes/readme.md"));
        assert!(sanitize_relative_path("../secret").is_err());
        assert!(sanitize_relative_path("notes/../../secret").is_err());
        assert!(sanitize_relative_path("/etc/passwd").is_err());
        assert!(sanitize_relative_path("C:\\Windows").is_err());
    }
}
