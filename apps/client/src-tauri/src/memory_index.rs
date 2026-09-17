//! SQLite owns memory; this directory contains only rebuildable vector indexes.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, OnceLock},
};
use tauri::Manager;
use zvec_rust::{
    Collection, CollectionOptions, CollectionSchema, ConfigBuilder, DataType, Doc, FieldSchema,
    HnswQueryParams, IndexParams, MetricType, SearchQuery, WriteResult,
};

type Result<T> = std::result::Result<T, String>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryVector {
    id: String,
    vector: Vec<f32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryQuery {
    namespace: String,
    model_key: String,
    vector: Vec<f32>,
    records: Vec<MemoryVector>,
    limit: usize,
}

#[derive(Debug, Serialize)]
pub struct MemoryHit {
    id: String,
    similarity: f32,
}

struct Index {
    key: String,
    collection: Collection,
    fingerprints: HashMap<String, String>,
}

// ponytail: one open collection and one lock bound mobile memory; use per-collection
// locks only if simultaneous assistant searches become a measured bottleneck.
static INDEX: Mutex<Option<Index>> = Mutex::new(None);
static INITIALIZED: OnceLock<Result<()>> = OnceLock::new();

#[tauri::command]
pub async fn reset_memory_index(app: tauri::AppHandle) -> Result<()> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("memory-zvec-v1");
    tauri::async_runtime::spawn_blocking(move || {
        let mut cached = INDEX.lock().map_err(|e| e.to_string())?;
        // ponytail: manual edits invalidate all derived indexes; target individual
        // collections if frequent edits make rebuilding measurable.
        *cached = None;
        match std::fs::remove_dir_all(root) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_memory_index(
    app: tauri::AppHandle,
    request: MemoryQuery,
) -> Result<Vec<MemoryHit>> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("memory-zvec-v1");
    tauri::async_runtime::spawn_blocking(move || {
        let mut index = INDEX.lock().map_err(|e| e.to_string())?;
        search(&root, &mut index, request)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn search(root: &Path, cached: &mut Option<Index>, request: MemoryQuery) -> Result<Vec<MemoryHit>> {
    validate(&request)?;
    INITIALIZED
        .get_or_init(|| {
            zvec_rust::initialize(Some(
                &ConfigBuilder::new()
                    .memory_limit(128 * 1024 * 1024)
                    .num_threads(2),
            ))
            .map_err(|e| e.to_string())
        })
        .clone()?;
    let key = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(&request.namespace, &request.model_key, request.vector.len(),))
                .map_err(|e| e.to_string())?
        )
    );
    if cached.as_ref().map(|index| &index.key) != Some(&key) {
        *cached = None; // Close the previous collection before opening the next one.
        *cached = Some(open(root, key, request.vector.len())?);
    }
    let index = cached.as_mut().ok_or("Missing memory index")?;
    let result = sync_and_query(index, &request);
    if result.is_err() {
        // A partial write must never leave our in-memory manifest ahead of disk.
        *cached = None;
    }
    result
}

fn open(root: &Path, key: String, dimensions: usize) -> Result<Index> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = root.join(&key);
    let path = path.to_str().ok_or("Memory index path is not UTF-8")?;
    let mut options = CollectionOptions::new().map_err(|e| e.to_string())?;
    options
        .set_max_buffer_size(4 * 1024 * 1024)
        .map_err(|e| e.to_string())?;
    let collection = if Path::new(path).exists() {
        Collection::open(path, Some(&options))
    } else {
        let schema = CollectionSchema::builder("memory")
            .add_field(
                FieldSchema::new("fingerprint", DataType::String, false, 0)
                    .map_err(|e| e.to_string())?,
            )
            .add_vector_field(
                "embedding",
                DataType::VectorFp32,
                dimensions as u32,
                IndexParams::hnsw(MetricType::Cosine, 16, 100).map_err(|e| e.to_string())?,
            )
            .build()
            .map_err(|e| e.to_string())?;
        Collection::create_and_open(path, &schema, Some(&options))
    }
    .map_err(|e| e.to_string())?;
    let mut fingerprints = HashMap::new();
    for doc in collection
        .iter_with_options(Some(&["fingerprint"]), false)
        .map_err(|e| e.to_string())?
    {
        let doc = doc.map_err(|e| e.to_string())?;
        fingerprints.insert(
            doc.get_pk().ok_or("Index document has no ID")?.to_owned(),
            doc.get_string("fingerprint")
                .map_err(|e| e.to_string())?
                .unwrap_or_default(),
        );
    }
    Ok(Index {
        key,
        collection,
        fingerprints,
    })
}

fn check_write(result: WriteResult, expected: usize) -> Result<()> {
    if result.error_count > 0 || result.success_count != expected as u64 {
        return Err(format!("Memory index write failed: {:?}", result.results));
    }
    Ok(())
}

fn sync_and_query(index: &mut Index, request: &MemoryQuery) -> Result<Vec<MemoryHit>> {
    let current: HashMap<_, _> = request
        .records
        .iter()
        .map(|record| {
            let mut hash = Sha256::new();
            for value in &record.vector {
                hash.update(value.to_le_bytes());
            }
            (record.id.clone(), format!("{:x}", hash.finalize()))
        })
        .collect();
    let removed: Vec<_> = index
        .fingerprints
        .keys()
        .filter(|id| !current.contains_key(*id))
        .map(String::as_str)
        .collect();
    if !removed.is_empty() {
        check_write(
            index
                .collection
                .delete(&removed)
                .map_err(|e| e.to_string())?,
            removed.len(),
        )?;
    }
    let changed: Vec<_> = request
        .records
        .iter()
        .filter(|record| index.fingerprints.get(&record.id) != current.get(&record.id))
        .collect();
    for batch in changed.chunks(64) {
        let docs: Vec<_> = batch
            .iter()
            .map(|record| {
                let mut doc = Doc::new().map_err(|e| e.to_string())?;
                doc.set_pk(&record.id);
                doc.add_string("fingerprint", &current[&record.id])
                    .map_err(|e| e.to_string())?;
                doc.add_vector_f32("embedding", &record.vector)
                    .map_err(|e| e.to_string())?;
                Ok(doc)
            })
            .collect::<Result<_>>()?;
        check_write(
            index
                .collection
                .upsert(&docs.iter().collect::<Vec<_>>())
                .map_err(|e| e.to_string())?,
            docs.len(),
        )?;
    }
    if !removed.is_empty() || !changed.is_empty() {
        index.collection.flush().map_err(|e| e.to_string())?;
        index.collection.optimize().map_err(|e| e.to_string())?;
    }
    index.fingerprints = current;
    if request.records.is_empty() {
        return Ok(Vec::new());
    }
    let mut query = SearchQuery::new("embedding", &request.vector, request.limit as i32)
        .map_err(|e| e.to_string())?;
    query
        .set_hnsw_params(HnswQueryParams::new(100, 0.0, false, false))
        .map_err(|e| e.to_string())?;
    query.set_include_vector(true).map_err(|e| e.to_string())?;
    index
        .collection
        .query(&query)
        .map_err(|e| e.to_string())?
        .iter()
        .map(|doc| {
            // Recompute cosine for returned candidates: do not confuse native distance with similarity.
            let vector = doc
                .get_vector_f32("embedding")
                .map_err(|e| e.to_string())?
                .ok_or("Index result has no vector")?;
            let dot: f32 = vector.iter().zip(&request.vector).map(|(a, b)| a * b).sum();
            let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt()
                * request.vector.iter().map(|v| v * v).sum::<f32>().sqrt();
            Ok(MemoryHit {
                id: doc.get_pk().ok_or("Index result has no ID")?.to_owned(),
                similarity: (dot / norm).clamp(-1.0, 1.0),
            })
        })
        .collect()
}

fn validate(request: &MemoryQuery) -> Result<()> {
    let dimensions = request.vector.len();
    let valid_vector = |vector: &[f32]| {
        vector.len() == dimensions
            && vector.iter().all(|v| v.is_finite() && v.abs() <= 1.0e10)
            && vector.iter().map(|v| v * v).sum::<f32>() > 0.0
    };
    if request.namespace.is_empty()
        || request.namespace.len() > 512
        || request.model_key.is_empty()
        || request.model_key.len() > 4096
        || !(1..=8192).contains(&dimensions)
        || !(1..=200).contains(&request.limit)
        || !valid_vector(&request.vector)
    {
        return Err("Invalid memory index query".into());
    }
    let mut ids = std::collections::HashSet::new();
    for record in &request.records {
        if record.id.is_empty()
            || record.id.len() > 256
            || record.id.contains('\0')
            || !valid_vector(&record.vector)
            || !ids.insert(&record.id)
        {
            return Err("Invalid or duplicate memory vector".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_index_reopens_updates_deletes_and_isolates_models() {
        let root = std::env::temp_dir().join(format!("nkg-zvec-test-{}", std::process::id()));
        let request = |model: &str, records: Vec<(&str, Vec<f32>)>| MemoryQuery {
            namespace: "test".into(),
            model_key: model.into(),
            vector: vec![1.0, 0.0],
            limit: 8,
            records: records
                .into_iter()
                .map(|(id, vector)| MemoryVector {
                    id: id.into(),
                    vector,
                })
                .collect(),
        };
        let mut cached = None;
        let result = search(
            &root,
            &mut cached,
            request("a", vec![("cat", vec![1.0, 0.0]), ("dog", vec![0.0, 1.0])]),
        )
        .unwrap();
        assert_eq!(result[0].id, "cat");
        assert!((result[0].similarity - 1.0).abs() < 1.0e-5);
        cached = None;
        let result = search(
            &root,
            &mut cached,
            request("a", vec![("dog", vec![1.0, 0.0])]),
        )
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "dog");
        assert!((result[0].similarity - 1.0).abs() < 1.0e-5);
        assert!(search(&root, &mut cached, request("b", vec![]))
            .unwrap()
            .is_empty());
        assert!(search(
            &root,
            &mut cached,
            request("b", vec![("bad\0id", vec![1.0, 0.0])])
        )
        .is_err());
        drop(cached);
        std::fs::remove_dir_all(root).unwrap();
    }
}
