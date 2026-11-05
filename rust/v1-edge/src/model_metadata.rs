//! Materialized four-source catalog produced by the control plane. No network on the edge.
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::{Mutex, OnceLock}, time::{Duration, Instant}};

#[derive(Default)]
struct Catalog { checked: Option<Instant>, providers: HashMap<String, Vec<Value>> }
static CACHE: OnceLock<Mutex<Catalog>> = OnceLock::new();

fn read_catalog() -> Option<HashMap<String, Vec<Value>>> {
    let path = std::env::var_os("SDK_MODELS_DEV_CACHE_PATH").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("STORE_PATH").unwrap_or_else(|| "/data/accounts.json".into())).with_file_name("models-dev-catalog.json")
    });
    if !std::fs::metadata(&path).is_ok_and(|m| m.len() <= 96 * 1024 * 1024) { return None; }
    let value: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if value["version"] != 2 || value["unifiedVersion"] != 1 { return None; }
    serde_json::from_value(value["providers"].clone()).ok()
}

fn resolve(providers: &HashMap<String, Vec<Value>>, provider: &str, id: &str) -> Option<Value> {
    // Provider-qualified matches never borrow another host's controls or prices.
    if let Some(found) = providers.get(provider).and_then(|models| models.iter().find(|m| m["id"] == id)) { return Some(found.clone()); }
    // A local routing id may identify several deployments. Transfer only agreed facts.
    let candidates = providers.values().flat_map(|models| models.iter()).filter(|m| m["id"] == id || m.pointer("/knowledge/canonicalId").and_then(Value::as_str) == Some(id)).collect::<Vec<_>>();
    if candidates.is_empty() { return None; }
    let mut result = json!({"id": id});
    let mut sources = Vec::new();
    let mut conflicts = serde_json::Map::new();
    for candidate in &candidates { if let Some(records) = candidate.pointer("/knowledge/sources").and_then(Value::as_array) { sources.extend(records.iter().cloned()); } }
    for key in ["name", "context", "inputLimit", "output", "input", "outputModalities", "tools", "reasoning", "efforts", "defaultEffort", "toggle", "budget", "structuredOutput", "temperature"] {
        let values = candidates.iter().filter_map(|m| m.get(key)).collect::<Vec<_>>();
        if let Some(first) = values.first() {
            if values.iter().all(|v| *v == *first) { result[key] = (*first).clone(); }
            else { conflicts.insert(key.to_owned(), Value::Array(values.iter().map(|v| (*v).clone()).collect())); }
        }
    }
    result["knowledge"] = json!({"sources": sources, "conflicts": conflicts, "match": "cross-provider-consensus"});
    Some(result)
}

pub(super) fn enrich(models: &mut [Value]) {
    let mut cache = CACHE.get_or_init(|| Mutex::new(Catalog::default())).lock().unwrap_or_else(|e| e.into_inner());
    if cache.checked.is_none_or(|t| t.elapsed() >= Duration::from_secs(30)) {
        cache.checked = Some(Instant::now());
        if let Some(providers) = read_catalog() { cache.providers = providers; }
    }
    enrich_with(models, &cache.providers);
}

fn enrich_with(models: &mut [Value], providers: &HashMap<String, Vec<Value>>) {
    for model in models.iter_mut() {
        let Some(id) = model["id"].as_str() else { continue; };
        let provider = model.pointer("/metadata/sdk_provider").or_else(|| model.pointer("/metadata/provider")).and_then(Value::as_str).unwrap_or("");
        let bare = id.strip_prefix(&format!("{provider}/")).unwrap_or(id);
        let Some(record) = resolve(providers, provider, bare) else { continue; };
        let Some(metadata) = model.get_mut("metadata").and_then(Value::as_object_mut) else { continue; };
        metadata.insert("model_knowledge".to_owned(), record["knowledge"].clone());
        for (source, target) in [("name", "display_name"), ("context", "context_window"), ("inputLimit", "max_input_tokens"), ("output", "max_output_tokens"), ("input", "input_modalities"), ("outputModalities", "output_modalities"), ("tools", "supports_tools"), ("reasoning", "supports_reasoning"), ("structuredOutput", "supports_structured_output"), ("temperature", "supports_temperature"), ("defaultEffort", "default_reasoning_level"), ("cost", "pricing")] {
            if let Some(value) = record.get(source).filter(|v| !v.is_null()) {
                if metadata.get(target).is_none_or(Value::is_null) { metadata.insert(target.to_owned(), value.clone()); }
            }
        }
        if metadata.get("reasoning_options").is_none() {
            let mut options = Vec::new();
            if let Some(efforts) = record.get("efforts") { options.push(json!({"type":"effort","values":efforts})); }
            if record["toggle"] == true { options.push(json!({"type":"toggle"})); }
            if let Some(budget) = record.get("budget").and_then(Value::as_object) { let mut b = budget.clone(); b.insert("type".to_owned(), json!("budget_tokens")); options.push(Value::Object(b)); }
            if !options.is_empty() { metadata.insert("reasoning_options".to_owned(), json!(options)); }
        }
    }
}

pub(super) fn codex_reasoning(info: &mut Value, metadata: &Value) {
    if metadata["supports_reasoning"] == false { return; }
    let levels = metadata["reasoning_options"].as_array().and_then(|options| options.iter().find(|o| o["type"] == "effort")).and_then(|o| o["values"].as_array());
    if let Some(levels) = levels {
        // Native upstream Codex metadata remains authoritative when populated.
        if info["supported_reasoning_levels"].as_array().is_none_or(Vec::is_empty) {
            info["supported_reasoning_levels"] = json!(levels.iter().filter_map(Value::as_str).filter(|s| !["default", "off"].contains(s)).map(|effort| json!({"effort":effort,"description":format!("{effort} reasoning effort")})).collect::<Vec<_>>());
        }
    }
    if info.get("default_reasoning_level").is_none() {
        if let Some(default) = metadata.get("default_reasoning_level").and_then(Value::as_str) {
            if info["supported_reasoning_levels"].as_array().is_some_and(|levels| levels.iter().any(|l| l["effort"] == default)) { info["default_reasoning_level"] = json!(default); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_identity_runtime_precedence_and_consensus() {
        let db = HashMap::from([
            ("a".to_owned(), vec![json!({"id":"reasoner","context":100,"reasoning":true,"efforts":["low","high"],"defaultEffort":"high","knowledge":{"sources":[{"source":"pi"}]}})]),
            ("b".to_owned(), vec![json!({"id":"reasoner","context":200,"reasoning":true,"efforts":["medium"],"knowledge":{"sources":[]}})])]);
        let mut models = vec![json!({"id":"reasoner","metadata":{"provider":"a","context_window":500}}),json!({"id":"reasoner","metadata":{"provider":"openai-compatible"}})];
        enrich_with(&mut models, &db);
        assert_eq!(models[0]["metadata"]["context_window"],500);
        assert_eq!(models[0]["metadata"]["supports_reasoning"],true);
        assert_eq!(models[0]["metadata"]["reasoning_options"][0]["values"],json!(["low","high"]));
        assert!(models[1]["metadata"].get("reasoning_options").is_none());
        assert!(models[1]["metadata"]["model_knowledge"]["conflicts"].get("efforts").is_some());
        let mut info=json!({"supported_reasoning_levels":[]}); codex_reasoning(&mut info,&models[0]["metadata"]);
        assert_eq!(info["default_reasoning_level"],"high");
        assert_eq!(info["supported_reasoning_levels"][1]["effort"],"high");
        assert!(resolve(&db,"a","unknown").is_none());
    }
}
