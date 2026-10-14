//! Canonicalize only a recognized, stateless Codex startup developer run.
use serde_json::{json, Value};

const SUMMARY: &str = "========= MEMORY_SUMMARY BEGINS";
const PROJECTLESS: &str = "### Projectless Chat\n";

fn parts(text: &str) -> Option<Vec<(u8, &str)>> {
    if text.starts_with("## Memory\n") {
        return Some(match text.find(SUMMARY) {
            Some(at) => vec![(3, &text[..at]), (8, &text[at..])],
            None => vec![(3, text)],
        });
    }
    if text.starts_with("<app-context>") {
        return Some(match text.find(PROJECTLESS) {
            Some(at) if text[at..].contains("/Users/") => vec![(5, &text[..at]), (9, &text[at..])],
            _ => vec![(5, text)],
        });
    }
    [
        ("<permissions instructions>", 0),
        ("<multi_agent_mode>", 1),
        ("<collaboration_mode>", 2),
        ("<multi_agent_role>", 4),
        ("<skills_instructions>", 6),
        ("<tools>", 7),
        (SUMMARY, 8),
        (PROJECTLESS, 9),
        ("<codex_apps_client_time_context>", 10),
    ]
    .into_iter()
    .find(|(prefix, _)| text.starts_with(prefix))
    .map(|(_, rank)| vec![(rank, text)])
}

pub(crate) fn optimize(body: &Value) -> Option<Value> {
    if body
        .get("previous_response_id")
        .is_some_and(|v| !v.is_null())
        || body.get("conversation").is_some_and(|v| !v.is_null())
    {
        return None;
    }
    let input = body.get("input")?.as_array()?;
    let start = input
        .iter()
        .take_while(|m| m.get("role").and_then(Value::as_str) == Some("system"))
        .count();
    let mut end = start;
    let mut chunks = Vec::new();
    while let Some(message) = input
        .get(end)
        .filter(|m| m.get("role").and_then(Value::as_str) == Some("developer"))
    {
        end += 1;
        let object = message.as_object()?;
        if object
            .keys()
            .any(|k| !matches!(k.as_str(), "role" | "type" | "content"))
            || object
                .get("type")
                .is_some_and(|v| v.as_str() != Some("message"))
        {
            return None;
        }
        let content = message.get("content")?;
        let blocks: Vec<&Value> = if content.is_string() {
            vec![content]
        } else {
            content.as_array()?.iter().collect()
        };
        if blocks.is_empty() {
            return None;
        }
        for block in blocks {
            if !content.is_string() && block.is_string() {
                return None;
            }
            let text = if let Some(text) = block.as_str() {
                text
            } else {
                let fields = block.as_object()?;
                if fields.get("type").and_then(Value::as_str) != Some("input_text")
                    || fields
                        .keys()
                        .any(|k| !matches!(k.as_str(), "type" | "text"))
                {
                    return None;
                }
                fields.get("text")?.as_str()?
            };
            for (rank, part) in parts(text)? {
                chunks.push((rank, message, part));
            }
        }
    }
    if ![3, 5, 6, 8]
        .iter()
        .all(|rank| chunks.iter().any(|c| &c.0 == rank))
    {
        return None;
    }
    chunks.sort_by_key(|c| c.0);
    let mut reordered = input[..start].to_vec();
    for (_, message, text) in chunks {
        let mut message = message.clone();
        message["content"] = if message["content"].is_string() {
            json!(text)
        } else {
            json!([{"type":"input_text", "text":text}])
        };
        reordered.push(message);
    }
    reordered.extend_from_slice(&input[end..]);
    let mut result = body.clone();
    result["input"] = Value::Array(reordered);
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../test-fixtures/codex-prefix.json")).unwrap()
    }
    #[test]
    fn shared_fixture_preserves_history_and_is_idempotent() {
        let data = fixture();
        let result = optimize(&data["input"]).unwrap();
        assert_eq!(result, data["expected"]);
        assert_eq!(optimize(&result).unwrap(), result);
    }
    #[test]
    fn opaque_contracts_and_unknown_instructions_are_not_rewritten() {
        for variant in 0..7 {
            let mut body = fixture()["input"].clone();
            match variant {
                0 => body["previous_response_id"] = json!("response-1"),
                1 => body["conversation"] = json!("conversation-1"),
                2 => body["input"][1]["id"] = json!("message-1"),
                3 => {
                    body["input"][1]["content"][0]["prompt_cache_breakpoint"] =
                        json!({"mode":"explicit"})
                }
                4 => body["input"][1]["content"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"type":"input_text","text":"Unknown overriding instruction."})),
                5 => body["input"][1]["content"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"type":"input_image","image_url":"opaque"})),
                _ => body["input"][0] = json!({"role":"user","content":"literal markup"}),
            }
            assert!(optimize(&body).is_none(), "variant {variant}");
        }
    }
}
