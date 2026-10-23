use super::*;
use axum::extract::{FromRequest, Multipart};

pub(super) fn is_image_path(path: &str) -> bool {
    matches!(path, "/images/generations" | "/images/edits" | "/v1/images/generations" | "/v1/images/edits")
}

pub(super) async fn read_body(req: Request<Body>, limit: usize) -> Result<(HeaderMap, Value, Option<Bytes>), Response> {
    let content_type = header_value(req.headers(), "content-type").unwrap_or_default();
    let (headers, body, upload) = if content_type.to_ascii_lowercase().starts_with("multipart/form-data") {
        if !req.uri().path().ends_with("/edits") {
            return Err(error_response(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Image generations require JSON.", "invalid_request_error"));
        }
        let (parts, body) = req.into_parts();
        let bytes = to_bytes(body, limit).await.map_err(|_| error_response(StatusCode::PAYLOAD_TOO_LARGE, "Image request is too large.", "invalid_request_error"))?;
        let headers = parts.headers.clone();
        let req = Request::from_parts(parts, Body::from(bytes.clone()));
        let mut form = Multipart::from_request(req, &()).await.map_err(|_| invalid_form())?;
        let mut values = Map::new();
        let mut has_image = false;
        while let Some(field) = form.next_field().await.map_err(|_| invalid_form())? {
            let name = field.name().unwrap_or_default().to_owned();
            if matches!(name.as_str(), "image" | "image[]" | "images" | "images[]") {
                has_image = true;
            }
            if matches!(name.as_str(), "model" | "prompt" | "stream") {
                if values.contains_key(&name) { return Err(invalid_form()); }
                let value = field.text().await.map_err(|_| invalid_form())?;
                values.insert(name, Value::String(value));
            }
        }
        if !has_image { return Err(invalid_form()); }
        (headers, Value::Object(values), Some(bytes))
    } else {
        let (headers, body, _) = read_json_body(req, limit, false).await?;
        (headers, body, None)
    };
    if value_string(body.get("model")).is_none()
        || value_string(body.get("prompt")).is_none()
        || body.get("stream").is_some_and(|value| value != &Value::Bool(false) && value.as_str() != Some("false")) {
        return Err(error_response(StatusCode::BAD_REQUEST, "Images require an explicit model, a non-empty prompt and no streaming.", "invalid_request_error"));
    }
    Ok((headers, body, upload))
}

fn invalid_form() -> Response {
    error_response(StatusCode::BAD_REQUEST, "Invalid image edit multipart form (model, prompt and image required).", "invalid_request_error")
}
