//! Request-scoped adaptation of client tools for function-only providers.
use serde_json::{Value, json};

#[derive(Clone, Default)]
pub(crate) struct ChatTools {
    // Alias, original name, optional namespace, free-form input.
    entries: Vec<(String, String, Option<String>, bool)>,
    unavailable_tools: Vec<String>,
}

impl ChatTools {
    pub(crate) fn prepare(body: &Value) -> Result<(Value, Self), String> {
        let mut adapter = Self::default();
        let mut body = body.clone();
        let Some(tools) = body.get("tools") else {
            return Ok((body, adapter));
        };
        let tools = tools.as_array().ok_or("tools must be an array")?;
        let mut flattened = Vec::new();
        for (index, tool) in tools.iter().enumerate() {
            // Codex advertises hosted web search even for unrelated coding turns.
            // It cannot run on a function-only upstream. Make optional capability
            // loss explicit to both the model and the HTTP client; never pretend
            // to execute it or relax an explicit tool selection.
            if matches!(
                tool["type"].as_str(),
                Some("web_search" | "web_search_preview" | "web_search_preview_2025_03_11")
            ) {
                let choice = body.get("tool_choice");
                if choice.is_some_and(|choice| {
                    matches!(
                        choice["type"].as_str(),
                        Some("web_search" | "web_search_preview" | "web_search_preview_2025_03_11")
                    )
                }) {
                    return Err(format!(
                        "tools[{index}]: explicitly selected web search requires an upstream with native Responses web search support"
                    ));
                }
                let kind = tool["type"].as_str().unwrap().to_owned();
                if !adapter.unavailable_tools.contains(&kind) {
                    adapter.unavailable_tools.push(kind);
                }
                continue;
            }
            if tool["type"] == "namespace" {
                let namespace = tool["name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("namespace requires a name")?;
                for (child_index, child) in tool["tools"]
                    .as_array()
                    .ok_or("namespace requires tools")?
                    .iter()
                    .enumerate()
                {
                    adapter
                        .add(child, Some(namespace), &mut flattened)
                        .map_err(|message| {
                            format!("tools[{index}].tools[{child_index}]: {message}")
                        })?;
                }
            } else {
                adapter
                    .add(tool, None, &mut flattened)
                    .map_err(|message| format!("tools[{index}]: {message}"))?;
            }
        }
        // Aliases are request-local and must never shadow a real function.
        for (alias, _, _, _) in &adapter.entries {
            if tools
                .iter()
                .any(|t| t["name"] == *alias || t["function"]["name"] == *alias)
            {
                return Err("tool name conflicts with a bridge alias".into());
            }
        }
        if !adapter.unavailable_tools.is_empty() {
            if body["tool_choice"] == "required" && flattened.is_empty() {
                return Err("tool_choice required cannot be satisfied: this upstream has no native Responses web search support".into());
            }
            let instructions = body
                .get("instructions")
                .and_then(Value::as_str)
                .unwrap_or_default();
            body["instructions"] = json!(format!(
                "{instructions}\n\nProvider capability notice: the native Responses web_search tool is unavailable on this upstream. All advertised client function tools remain available. If web research is needed, use an available client search/browser tool; if none is available, explain that limitation. Do not claim to have searched or fabricate search results."
            ));
        }
        body["tools"] = Value::Array(flattened);
        if let Some(choice) = body.get_mut("tool_choice") {
            let name = choice["name"].as_str().unwrap_or("");
            let namespace = choice["namespace"].as_str();
            if let Some((alias, _, _, _)) = adapter
                .entries
                .iter()
                .find(|(_, n, ns, _)| n == name && ns.as_deref() == namespace)
            {
                *choice = json!({"type": "function", "name": alias});
            }
        }
        if let Some(items) = body.get_mut("input").and_then(Value::as_array_mut) {
            for item in items {
                if !matches!(
                    item["type"].as_str(),
                    Some("function_call" | "custom_tool_call")
                ) {
                    continue;
                }
                let name = item["name"].as_str().unwrap_or("");
                let namespace = item["namespace"].as_str();
                if let Some((alias, _, _, custom)) = adapter
                    .entries
                    .iter()
                    .find(|(_, n, ns, _)| n == name && ns.as_deref() == namespace)
                {
                    if *custom {
                        let input = item["input"]
                            .as_str()
                            .ok_or("custom tool call requires string input")?;
                        item["arguments"] = Value::String(json!({"input": input}).to_string());
                        item.as_object_mut().unwrap().remove("input");
                    }
                    item["type"] = json!("function_call");
                    item["name"] = json!(alias);
                    item.as_object_mut().unwrap().remove("namespace");
                }
            }
        }
        Ok((body, adapter))
    }

    fn add(
        &mut self,
        tool: &Value,
        namespace: Option<&str>,
        output: &mut Vec<Value>,
    ) -> Result<(), String> {
        let custom = tool["type"] == "custom";
        if !custom && tool["type"] != "function" {
            let kind = tool["type"].as_str().unwrap_or("missing");
            let kind: String = kind
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
                .take(64)
                .collect();
            return Err(format!(
                "unsupported tool type '{kind}' for the Chat Completions bridge"
            ));
        }
        let source = tool.get("function").unwrap_or(tool);
        let name = source["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or("tool requires a name")?;
        if !custom && namespace.is_none() {
            output.push(tool.clone());
            return Ok(());
        }
        let alias = format!("mv_tool_{}", self.entries.len());
        let mut converted = source.clone();
        converted["description"] = json!(format!(
            "Tool {}{}: {}",
            namespace.map(|ns| format!("{ns}. ")).unwrap_or_default(),
            name,
            source["description"].as_str().unwrap_or("")
        ));
        converted["type"] = json!("function");
        converted["name"] = json!(alias);
        if custom {
            let mut description = converted["description"].as_str().unwrap_or("").to_owned();
            description.push_str("\nPass the complete raw tool input as the input string.");
            if let Some(format) = source.get("format") {
                description.push_str(&format!("\nThe input must obey this format: {format}"));
            }
            converted["description"] = json!(description);
            converted["parameters"] = json!({"type": "object", "properties": {"input": {"type": "string"}}, "required": ["input"], "additionalProperties": false});
            converted.as_object_mut().unwrap().remove("format");
        }
        self.entries
            .push((alias, name.to_owned(), namespace.map(str::to_owned), custom));
        output.push(converted);
        Ok(())
    }

    pub(crate) fn add_response_headers(&self, headers: &mut Vec<(String, String)>) {
        if !self.unavailable_tools.is_empty() {
            headers.push((
                "x-multivibe-unavailable-tools".into(),
                self.unavailable_tools.join(","),
            ));
        }
    }

    pub(crate) fn restore_item(&self, item: &mut Value) -> Result<(), String> {
        if item["type"] != "function_call" {
            return Ok(());
        }
        let Some((_, name, namespace, custom)) = self
            .entries
            .iter()
            .find(|(alias, _, _, _)| item["name"] == *alias)
        else {
            return Ok(());
        };
        if *custom {
            let args: Value = serde_json::from_str(item["arguments"].as_str().unwrap_or(""))
                .map_err(|_| "upstream returned invalid custom tool arguments")?;
            let input = args["input"]
                .as_str()
                .ok_or("upstream custom tool arguments require string input")?;
            item["input"] = json!(input);
            item["type"] = json!("custom_tool_call");
            item.as_object_mut().unwrap().remove("arguments");
        }
        item["name"] = json!(name);
        if let Some(namespace) = namespace {
            item["namespace"] = json!(namespace);
        }
        Ok(())
    }

    pub(crate) fn restore_response(&self, response: &mut Value) -> Result<(), String> {
        if let Some(items) = response.get_mut("output").and_then(Value::as_array_mut) {
            for item in items {
                self.restore_item(item)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_and_namespaced_tools_round_trip_without_losing_raw_input() {
        let raw = "print(\"été\\n\")\n";
        let body = json!({"tools": [
            {"type": "function", "name": "ordinary"},
            {"type": "namespace", "name": "functions", "tools": [
                {"type": "custom", "name": "exec", "format": {"type": "text"}},
                {"type": "function", "name": "wait", "parameters": {"type": "object"}}
            ]}
        ], "tool_choice": {"type": "custom", "name": "exec", "namespace": "functions"},
        "input": [
            {"type": "custom_tool_call", "call_id": "call_1", "name": "exec", "namespace": "functions", "input": raw},
            {"type": "custom_tool_call_output", "call_id": "call_1", "output": "ok"}
        ]});
        let (adapted, adapter) = ChatTools::prepare(&body).unwrap();
        assert_eq!(adapted["tools"].as_array().unwrap().len(), 3);
        assert_eq!(adapted["tools"][0], body["tools"][0]);
        assert_eq!(adapted["tool_choice"]["name"], "mv_tool_0");
        assert_eq!(adapted["input"][1], body["input"][1]);
        let mut item = adapted["input"][0].clone();
        adapter.restore_item(&mut item).unwrap();
        assert_eq!(item, body["input"][0]);
        let mut function = json!({"type": "function_call", "name": "mv_tool_1", "arguments": "{}"});
        adapter.restore_item(&mut function).unwrap();
        assert_eq!(function["name"], "wait");
        assert_eq!(function["namespace"], "functions");
        assert_eq!(function["type"], "function_call");
        assert!(ChatTools::prepare(&json!({"tools": [{"type": "file_search"}]})).is_err());
    }

    #[test]
    fn codex_optional_web_search_does_not_block_client_tools() {
        for kind in [
            "web_search",
            "web_search_preview",
            "web_search_preview_2025_03_11",
        ] {
            for choice in [Value::Null, json!("auto"), json!("none"), json!("required")] {
                let mut body = json!({"instructions": "Keep existing instructions.", "tools": [
                    {"type": "function", "name": "exec_command", "parameters": {"type": "object"}},
                    {"type": "custom", "name": "apply_patch"},
                    {"type": "namespace", "name": "browser", "tools": [{"type": "function", "name": "search"}]},
                    {"type": kind, "external_web_access": false}
                ]});
                if !choice.is_null() {
                    body["tool_choice"] = choice.clone();
                }
                let (adapted, adapter) = ChatTools::prepare(&body).unwrap();
                assert_eq!(adapted["tools"].as_array().unwrap().len(), 3);
                assert_eq!(adapted["tools"][0], body["tools"][0]);
                assert_eq!(adapted["tool_choice"], choice);
                assert!(
                    adapted["instructions"]
                        .as_str()
                        .unwrap()
                        .starts_with("Keep existing instructions.")
                );
                assert!(
                    adapted["instructions"]
                        .as_str()
                        .unwrap()
                        .contains("web_search tool is unavailable")
                );
                let mut headers = Vec::new();
                adapter.add_response_headers(&mut headers);
                assert_eq!(
                    headers,
                    vec![("x-multivibe-unavailable-tools".into(), kind.into())]
                );
            }
            for body in [
                json!({"tools": [{"type": kind}], "tool_choice": "required"}),
                json!({"tools": [{"type": kind}, {"type": "function", "name": "exec"}], "tool_choice": {"type": kind}}),
            ] {
                assert!(
                    ChatTools::prepare(&body)
                        .err()
                        .unwrap()
                        .contains("web search")
                );
            }
        }
        let error = ChatTools::prepare(
            &json!({"tools": [{"type": "function", "name": "exec"}, {"type": "file_search"}]}),
        )
        .err()
        .unwrap();
        assert!(error.contains("tools[1]"));
        assert!(error.contains("'file_search'"));
    }

    #[test]
    fn invalid_custom_output_is_never_executed_as_a_function() {
        let (_, adapter) =
            ChatTools::prepare(&json!({"tools": [{"type": "custom", "name": "exec"}]})).unwrap();
        for arguments in ["broken", "{}", "{\"input\":42}"] {
            assert!(adapter.restore_item(&mut json!({"type": "function_call", "name": "mv_tool_0", "arguments": arguments})).is_err());
        }
        assert!(
            ChatTools::prepare(&json!({"tools": [
                {"type": "custom", "name": "exec"}, {"type": "function", "name": "mv_tool_0"}
            ]}))
            .is_err()
        );
    }
}
