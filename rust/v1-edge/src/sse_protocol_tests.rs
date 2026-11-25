use super::*;

#[test]
fn upstream_error_codes_map_to_fixed_client_messages() {
    assert_eq!(
        client_error_message("server_overloaded"),
        "upstream is at capacity, retry later"
    );
    assert_eq!(
        client_error_message("rate_limit_exceeded"),
        "upstream rate limit reached, retry later"
    );
    assert_eq!(
        client_error_message("content_filter"),
        "upstream rejected the request under its content policy"
    );
    assert_eq!(
        client_error_message("invalid_request"),
        "upstream rejected the request"
    );
    // Anything unrecognized, including text an upstream put in the code field,
    // falls back to the generic message instead of being relayed.
    assert_eq!(
        client_error_message("acct_123 leaked"),
        "upstream stream reported an error"
    );
}

#[test]
fn log_text_cannot_forge_lines_or_inject_escapes() {
    let hostile = "boom\nINFO upstream healthy\r\u{1b}[2J";
    let safe = log_safe(hostile, 512);
    assert!(!safe.contains('\n'), "{safe}");
    assert!(!safe.contains('\r'), "{safe}");
    assert!(!safe.chars().any(|c| c.is_control()), "{safe}");
    assert_eq!(log_safe("abcdef", 3), "abc");
}

#[test]
fn decoder_strips_only_initial_bom_across_all_chunk_boundaries() {
    for sep in ["\n", "\r\n", "\r"] {
        for prefix in ["", "\u{feff}"] {
            let wire = format!("{prefix}data: {{\"text\":\"Zażółć 😀\u{feff}\"}}{sep}{sep}");
            let mut decoder = SseDecoder::new();
            let mut events = Vec::new();
            for byte in wire.as_bytes().chunks(1) {
                events.extend(decoder.push(byte).events);
            }
            events.extend(decoder.finish());
            assert_eq!(events.len(), 1, "prefix={prefix:?}, separator={sep:?}");
            let value: Value = serde_json::from_str(&events[0].data).unwrap();
            assert_eq!(value["text"], "Zażółć 😀\u{feff}");
        }
    }
}

#[test]
fn responses_failures_do_not_become_chat_stop() {
    for kind in ["response.failed", "error", "response.error"] {
        let mut converter =
            SseStreamTransformer::new(StreamTransform::ResponseToChat, "test-model");
        let event = json!({"type":kind,"response":{"status":"failed","error":{"code":"test_failure","message":"fixture failure"}},"error":{"code":"test_failure","message":"fixture failure"}});
        let mut output = converter.push(sse_frame(kind, &event).as_bytes());
        output.push_str(&converter.finish_eof());
        let events = parse_sse_events(&output);
        assert!(
            !events
                .iter()
                .any(|(_, e)| e["choices"][0]["finish_reason"] == "stop"),
            "{output}"
        );
        assert_eq!(
            events
                .iter()
                .filter(|(name, e)| name == "error" || e["type"] == "error")
                .count(),
            1,
            "{output}"
        );
        assert_eq!(
            events
                .iter()
                .filter(|(_, e)| e.as_str() == Some("[DONE]"))
                .count(),
            1,
            "{output}"
        );
        // Upstream error text can carry account ids and request echoes, so the
        // client frame must not receive it verbatim.
        assert!(!output.contains("fixture failure"), "{output}");
        assert!(output.contains("upstream stream reported an error"), "{output}");
    }
}

#[test]
fn responses_incomplete_preserves_chat_finish_reason() {
    for (reason, expected) in [
        ("max_output_tokens", "length"),
        ("content_filter", "content_filter"),
    ] {
        let mut converter =
            SseStreamTransformer::new(StreamTransform::ResponseToChat, "test-model");
        let event = json!({"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":reason}}});
        let mut output = converter.push(sse_frame("response.incomplete", &event).as_bytes());
        output.push_str(&converter.finish_eof());
        let events = parse_sse_events(&output);
        assert!(
            events
                .iter()
                .any(|(_, e)| e["choices"][0]["finish_reason"] == expected),
            "{output}"
        );
        assert!(
            !events
                .iter()
                .any(|(_, e)| e["choices"][0]["finish_reason"] == "stop"),
            "{output}"
        );
    }
}

#[test]
fn chat_terminal_snapshots_preserve_status_and_item_identity() {
    for (finish, status, terminal) in [
        ("stop", "completed", "response.completed"),
        ("length", "incomplete", "response.incomplete"),
        ("content_filter", "incomplete", "response.incomplete"),
    ] {
        for delta in [
            json!({"content":"hello"}),
            json!({}),
            json!({"reasoning_content":"reason"}),
            json!({"tool_calls":[{"index":0,"id":"call_test","type":"function","function":{"name":"lookup","arguments":"{}"}}]}),
            json!({"refusal":"cannot comply"}),
        ] {
            let wire = format!(
                "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                json!({"object":"chat.completion.chunk","choices":[{"delta":delta,"finish_reason":null}]}),
                json!({"object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":finish}]}),
                json!({"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}})
            );
            let mut converter =
                SseStreamTransformer::new(StreamTransform::ChatToResponse, "test-model");
            let mut output = converter.push(wire.as_bytes());
            output.push_str(&converter.finish_eof());
            let events = parse_sse_events(&output);
            let response = &events
                .iter()
                .find(|(_, e)| e["type"] == terminal)
                .expect(&output)
                .1["response"];
            assert_eq!(response["status"], status);
            assert_eq!(response["usage"]["output_tokens"], 3);
            let items = response["output"].as_array().unwrap();
            if delta.get("reasoning_content").is_some() {
                // The existing public sanitizer intentionally removes reasoning-only items.
                assert!(items.is_empty(), "{output}");
            } else {
                assert!(
                    !items.is_empty(),
                    "finish={finish}, delta={delta}, output={output}"
                );
            }
            for item in items {
                assert!(
                    item["id"].as_str().is_some_and(|v| !v.is_empty()),
                    "{output}"
                );
                assert_eq!(item["status"], status, "{output}");
                let (_, done) = events
                    .iter()
                    .find(|(_, e)| {
                        e["type"] == "response.output_item.done" && e["item"]["id"] == item["id"]
                    })
                    .unwrap_or_else(|| panic!("no response.output_item.done for {item}: {output}"));
                assert_eq!(&done["item"], item, "{output}");
            }
            if finish != "stop" {
                assert!(
                    !events
                        .iter()
                        .any(|(_, e)| e["type"] == "response.completed"),
                    "{output}"
                );
                assert_eq!(
                    response["incomplete_details"]["reason"],
                    if finish == "length" {
                        "max_output_tokens"
                    } else {
                        "content_filter"
                    }
                );
            }
            if delta.get("refusal").is_some() {
                assert_eq!(items[0]["content"][0]["refusal"], "cannot comply");
            }
        }
    }
}

#[test]
fn buffered_chat_truncation_preserves_status_for_each_output_shape() {
    for finish in ["length", "content_filter"] {
        for message in [
            json!({"content":"hello"}),
            json!({"content":""}),
            json!({"reasoning_content":"reason"}),
            json!({"tool_calls":[{"id":"call_test","type":"function","function":{"name":"lookup","arguments":"{}"}}]}),
            json!({"refusal":"cannot comply"}),
        ] {
            let response = chat_to_response(
                &json!({"choices":[{"message":message,"finish_reason":finish}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}),
                "test-model",
            );
            assert_eq!(response["status"], "incomplete", "{response}");
            assert_eq!(
                response["incomplete_details"]["reason"],
                if finish == "length" {
                    "max_output_tokens"
                } else {
                    "content_filter"
                }
            );
            for item in response["output"].as_array().unwrap() {
                assert!(item["id"].as_str().is_some_and(|v| !v.is_empty()));
                assert_eq!(item["status"], "incomplete");
            }
        }
    }
}

async fn assert_held_open_terminal_closes(transform: StreamTransform, dialect: ClientDialect) {
    use axum::routing::get;
    use http_body_util::BodyExt;
    let wire = if transform == StreamTransform::ChatToResponse
        || (transform == StreamTransform::None && dialect == ClientDialect::Chat)
    {
        "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"object\":\"chat.completion.chunk\",\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\ndata: [DONE]\n\n"
    } else {
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}]}}\n\n"
    };
    let upstream = Router::new().route(
        "/sse",
        get(move || async move {
            let body = stream! {
                yield Ok::<Bytes, Infallible>(Bytes::from_static(wire.as_bytes()));
                std::future::pending::<()>().await;
            };
            Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(body))
                .unwrap()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let upstream = reqwest::get(format!("http://{address}/sse")).await.unwrap();
    let response = streaming_response(StreamingReply {
        chat_tools: chat_tools::ChatTools::default(),
        status: StatusCode::OK,
        headers: vec![("content-type".into(), "text/event-stream".into())],
        upstream,
        transform,
        dialect,
        requested_model: "test-model".into(),
        provider: "openai-compatible".into(),
        trace: None,
        capacity_lease: AdmissionLease {
            controller: Arc::new(AdmissionController::new(Arc::new(AtomicU64::new(0)))),
            account_id: None,
            application: None,
            borrowed_from_grace: false,
        },
        activity_lease: None,
        stream_heartbeat: Duration::from_secs(15),
        admission: None,
        admission_note: None,
    });
    let result =
        tokio::time::timeout(Duration::from_secs(10), response.into_body().collect()).await;
    task.abort();
    let text = String::from_utf8(
        result
            .expect("protocol terminal must close without upstream EOF")
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(!text.contains("stream_interrupted"));
    assert!(!text.contains("response.failed"));
    if transform == StreamTransform::ChatToResponse {
        assert!(text.contains("\"output_tokens\":1"), "{text}");
    }
}

#[tokio::test]
async fn native_responses_terminal_releases_held_open_socket() {
    assert_held_open_terminal_closes(StreamTransform::None, ClientDialect::Responses).await;
}
#[tokio::test]
async fn native_chat_done_releases_held_open_socket() {
    assert_held_open_terminal_closes(StreamTransform::None, ClientDialect::Chat).await;
}
#[tokio::test]
async fn responses_to_chat_terminal_releases_held_open_socket() {
    assert_held_open_terminal_closes(StreamTransform::ResponseToChat, ClientDialect::Chat).await;
}
#[tokio::test]
async fn chat_to_responses_terminal_releases_held_open_socket() {
    assert_held_open_terminal_closes(StreamTransform::ChatToResponse, ClientDialect::Responses)
        .await;
}

#[test]
fn refusal_streamed_before_content_keeps_distinct_content_indexes() {
    // An upstream may stream a refusal delta before any text. Both parts then
    // need their own content_index, and the terminal snapshot has to list them
    // in the order the client was told.
    let mut converter = SseStreamTransformer::new(StreamTransform::ChatToResponse, "m");
    let mut output = converter.push(
        b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"refusal\":\"cannot comply\"},\"finish_reason\":null}]}\n\n",
    );
    output.push_str(&converter.push(
        b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\n",
    ));
    output.push_str(&converter.push(
        b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    ));
    output.push_str(&converter.push(
        b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"total_tokens\":3}}\n\ndata: [DONE]\n\n",
    ));
    let events = parse_sse_events(&output);

    let part_index = |event_type: &str, part_type: &str| -> u64 {
        events
            .iter()
            .find(|(_, e)| e["type"] == event_type && e["part"]["type"] == part_type)
            .unwrap_or_else(|| panic!("no {event_type} for {part_type}: {output}"))
            .1["content_index"]
            .as_u64()
            .unwrap()
    };
    let refusal_index = part_index("response.content_part.added", "refusal");
    let text_index = part_index("response.content_part.added", "output_text");
    assert_ne!(refusal_index, text_index, "{output}");
    assert_eq!(
        part_index("response.content_part.done", "refusal"),
        refusal_index,
        "{output}"
    );
    assert_eq!(
        part_index("response.content_part.done", "output_text"),
        text_index,
        "{output}"
    );

    let (_, done) = events
        .iter()
        .find(|(_, e)| e["type"] == "response.output_item.done")
        .unwrap_or_else(|| panic!("no response.output_item.done: {output}"));
    let parts = done["item"]["content"].as_array().unwrap();
    assert_eq!(parts[refusal_index as usize]["type"], "refusal", "{output}");
    assert_eq!(
        parts[text_index as usize]["type"], "output_text",
        "{output}"
    );
    assert_eq!(parts[text_index as usize]["text"], "hello", "{output}");
}
