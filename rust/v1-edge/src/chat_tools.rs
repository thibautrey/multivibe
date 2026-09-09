//! Request-scoped adaptation of client tools for function-only providers.
use serde_json::{Value, json};

#[derive(Clone, Default)]
pub(crate) struct ChatTools {
    // Alias, original name, optional namespace, free-form input.
    entries: Vec<(String, String, Option<String>, bool)>,
}

impl ChatTools {
    pub(crate) fn prepare(body: &Value) -> Result<(Value, Self), String> {
        let mut adapter = Self::default();
        let mut body = body.clone();
        let Some(tools) = body.get("tools") else { return Ok((body, adapter)); };
        let tools = tools.as_array().ok_or("tools must be an array")?;
        let mut flattened = Vec::new();
        for tool in tools {
            if tool["type"] == "namespace" {
                let namespace = tool["name"].as_str().filter(|s| !s.is_empty()).ok_or("namespace requires a name")?;
                for child in tool["tools"].as_array().ok_or("namespace requires tools")? {
                    adapter.add(child, Some(namespace), &mut flattened)?;
                }
            } else {
                adapter.add(tool, None, &mut flattened)?;
            }
        }
        // Aliases are request-local and must never shadow a real function.
        for (alias, _, _, _) in &adapter.entries {
            if tools.iter().any(|t| t["name"] == *alias || t["function"]["name"] == *alias) {
                return Err("tool name conflicts with a bridge alias".into());
            }
        }
        body["tools"] = Value::Array(flattened);
        if let Some(choice) = body.get_mut("tool_choice") {
            let name = choice["name"].as_str().unwrap_or("");
            let namespace = choice["namespace"].as_str();
            if let Some((alias, _, _, _)) = adapter.entries.iter().find(|(_, n, ns, _)| n == name && ns.as_deref() == namespace) {
                *choice = json!({"type": "function", "name": alias});
            }
        }
        if let Some(items) = body.get_mut("input").and_then(Value::as_array_mut) {
            for item in items {
                if !matches!(item["type"].as_str(), Some("function_call" | "custom_tool_call")) { continue; }
                let name = item["name"].as_str().unwrap_or("");
                let namespace = item["namespace"].as_str();
                if let Some((alias, _, _, custom)) = adapter.entries.iter().find(|(_, n, ns, _)| n == name && ns.as_deref() == namespace) {
                    if *custom {
                        let input = item["input"].as_str().ok_or("custom tool call requires string input")?;
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

    fn add(&mut self, tool: &Value, namespace: Option<&str>, output: &mut Vec<Value>) -> Result<(), String> {
        let custom = tool["type"] == "custom";
        if !custom && tool["type"] != "function" {
            return Err("unsupported tool type for the Chat Completions bridge".into());
        }
        let source = tool.get("function").unwrap_or(tool);
        let name = source["name"].as_str().filter(|s| !s.trim().is_empty()).ok_or("tool requires a name")?;
        if !custom && namespace.is_none() { output.push(tool.clone()); return Ok(()); }
        let alias = format!("mv_tool_{}", self.entries.len());
        let mut converted = source.clone();
        converted["description"] = json!(format!("Tool {}{}: {}", namespace.map(|ns| format!("{ns}. ")).unwrap_or_default(), name, source["description"].as_str().unwrap_or("")));
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
        self.entries.push((alias, name.to_owned(), namespace.map(str::to_owned), custom));
        output.push(converted);
        Ok(())
    }

    pub(crate) fn restore_item(&self, item: &mut Value) -> Result<(), String> {
        if item["type"] != "function_call" { return Ok(()); }
        let Some((_, name, namespace, custom)) = self.entries.iter().find(|(alias, _, _, _)| item["name"] == *alias) else { return Ok(()); };
        if *custom {
            let args: Value = serde_json::from_str(item["arguments"].as_str().unwrap_or("")).map_err(|_| "upstream returned invalid custom tool arguments")?;
            let input = args["input"].as_str().ok_or("upstream custom tool arguments require string input")?;
            item["input"] = json!(input);
            item["type"] = json!("custom_tool_call");
            item.as_object_mut().unwrap().remove("arguments");
        }
        item["name"] = json!(name);
        if let Some(namespace) = namespace { item["namespace"] = json!(namespace); }
        Ok(())
    }

    pub(crate) fn restore_response(&self, response: &mut Value) -> Result<(), String> {
        if let Some(items) = response.get_mut("output").and_then(Value::as_array_mut) {
            for item in items { self.restore_item(item)?; }
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
        assert!(ChatTools::prepare(&json!({"tools": [{"type": "web_search_preview"}]})).is_err());
    }

    #[test]
    fn invalid_custom_output_is_never_executed_as_a_function() {
        let (_, adapter) = ChatTools::prepare(&json!({"tools": [{"type": "custom", "name": "exec"}]})).unwrap();
        for arguments in ["broken", "{}", "{\"input\":42}"] {
            assert!(adapter.restore_item(&mut json!({"type": "function_call", "name": "mv_tool_0", "arguments": arguments})).is_err());
        }
        assert!(ChatTools::prepare(&json!({"tools": [
            {"type": "custom", "name": "exec"}, {"type": "function", "name": "mv_tool_0"}
        ]})).is_err());
    }
}
