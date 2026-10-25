//! Read the control plane's validated models.dev cache. No network requests or
//! per-request file reads on the inference path; keep the last valid snapshot.
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

type Rates = (f64, f64, f64, f64);
const ORIGINS: &[&str] = &[
    "openai",
    "anthropic",
    "google",
    "deepseek",
    "xai",
    "mistral",
    "cohere",
    "groq",
    "cerebras",
    "perplexity",
    "zai",
    "z-ai",
    "moonshotai",
    "minimax",
];

fn rates(cost: &Value) -> Option<Rates> {
    let number = |key: &str| {
        cost.get(key)?
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
    };
    let input = number("input")?;
    Some((
        input,
        number("cache_read").unwrap_or(input),
        number("cache_write").unwrap_or(input),
        number("output")?,
    ))
}

fn prices(snapshot: &Value) -> Option<HashMap<String, Value>> {
    if snapshot["version"] != 2 {
        return None;
    }
    let mut result = HashMap::new();
    let mut bare = HashMap::new();
    for (provider, models) in snapshot["providers"].as_object()? {
        for model in models.as_array()? {
            let Some(id) = model["id"].as_str() else {
                continue;
            };
            let cost = &model["cost"];
            if rates(cost).is_none() {
                continue;
            }
            result.insert(format!("{provider}/{id}"), cost.clone());
            if ORIGINS.contains(&provider.as_str()) {
                bare.entry(id.to_owned())
                    .and_modify(|cost| *cost = None)
                    .or_insert(Some(cost.clone()));
            }
        }
    }
    if let Some(aliases) = snapshot["providerAliases"].as_object() {
        for (alias, provider) in aliases {
            let Some(provider) = provider.as_str() else {
                continue;
            };
            let Some(models) = snapshot["providers"][provider].as_array() else {
                continue;
            };
            for model in models {
                let Some(id) = model["id"].as_str() else {
                    continue;
                };
                if let Some(cost) = result.get(&format!("{provider}/{id}")).cloned() {
                    result.insert(format!("{alias}/{id}"), cost);
                }
            }
        }
    }
    for (id, cost) in bare {
        if let Some(cost) = cost {
            result.insert(id, cost);
        }
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

fn select(cost: &Value, input: u64) -> Option<Rates> {
    let mut selected = rates(cost)?;
    let mut threshold = 0;
    if let Some(tiers) = cost["tiers"].as_array() {
        for tier in tiers {
            let Some(size) = tier["tier"]["size"].as_u64() else {
                continue;
            };
            if tier["tier"]["type"] == "context" && input > size && size >= threshold {
                if let Some(rate) = rates(tier) {
                    selected = rate;
                    threshold = size;
                }
            }
        }
    }
    Some(selected)
}

#[derive(Default)]
struct Cache {
    checked: Option<Instant>,
    models: HashMap<String, Value>,
}

pub(super) fn lookup(model: &str, input: u64) -> Option<Rates> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(Cache::default()))
        .lock()
        .ok()?;
    if cache
        .checked
        .is_none_or(|checked| checked.elapsed() >= Duration::from_secs(30))
    {
        cache.checked = Some(Instant::now());
        let path = std::env::var_os("SDK_MODELS_DEV_CACHE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(
                    std::env::var_os("STORE_PATH").unwrap_or_else(|| "/data/accounts.json".into()),
                )
                .with_file_name("models-dev-catalog.json")
            });
        if std::fs::metadata(&path).is_ok_and(|m| m.len() <= 16 * 1024 * 1024) {
            if let Some(models) = std::fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|snapshot| prices(&snapshot))
            {
                cache.models = models;
            }
        }
    }
    select(cache.models.get(model)?, input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn shared_snapshot_keeps_context_tiers_and_provider_identity() {
        let sol = json!({"id":"gpt-6.1-sol","cost":{"input":2,"output":10,"cache_read":0.1,"cache_write":2.5,"tiers":[{"input":4,"output":15,"cache_read":0.2,"cache_write":5,"tier":{"type":"context","size":272000}}]}});
        let snapshot = json!({"version":2,"providerAliases":{"test-openai":"openai"},"providers":{"openai":[sol],"openrouter":[{"id":"gpt-6.1-sol","cost":{"input":99,"output":99}}]}});
        let prices = prices(&snapshot).unwrap();
        assert_eq!(
            select(&prices["gpt-6.1-sol"], 272000),
            Some((2.0, 0.1, 2.5, 10.0))
        );
        assert_eq!(
            select(&prices["openai/gpt-6.1-sol"], 272001),
            Some((4.0, 0.2, 5.0, 15.0))
        );
        assert_eq!(
            select(&prices["openrouter/gpt-6.1-sol"], 1),
            Some((99.0, 99.0, 99.0, 99.0))
        );
        assert_eq!(
            select(&prices["test-openai/gpt-6.1-sol"], 272001),
            Some((4.0, 0.2, 5.0, 15.0))
        );
        assert!(rates(&json!({"input":2})).is_none());
    }
}
