use serde_json::Value;

/// Filter console messages by log levels, search term, and timestamp.
pub fn filter_console_messages(
    messages: &[Value],
    log_levels: Option<&[String]>,
    search_term: Option<&str>,
    since: Option<f64>,
) -> Vec<Value> {
    let mut filtered: Vec<Value> = messages.to_vec();

    // Filter by log levels
    if let Some(levels) = log_levels {
        if !levels.is_empty() {
            filtered.retain(|msg| {
                let level = msg.get("level")
                    .or(msg.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                levels.iter().any(|l| l == level)
            });
        }
    }

    // Filter by search term
    if let Some(term) = search_term {
        let search_lower = term.to_lowercase();
        filtered.retain(|msg| {
            let text = msg.get("message")
                .or(msg.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            text.to_lowercase().contains(&search_lower)
        });
    }

    // Filter by timestamp
    if let Some(since_ts) = since {
        filtered.retain(|msg| {
            let msg_time = msg.get("timestamp")
                .or(msg.get("time"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            msg_time >= since_ts
        });
    }

    filtered
}

/// Filter network requests by method, status, resource type, domain, and failed-only flag.
pub fn filter_network_requests(
    requests: &[Value],
    method: Option<&str>,
    status: Option<&Value>,
    resource_type: Option<&str>,
    domain: Option<&str>,
    failed_only: bool,
) -> Vec<Value> {
    let mut filtered: Vec<Value> = requests.to_vec();

    // Filter by HTTP method
    if let Some(m) = method {
        let m_upper = m.to_uppercase();
        filtered.retain(|req| {
            let req_method = req.get("method")
                .or_else(|| req.get("request").and_then(|r| r.get("method")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            req_method.to_uppercase() == m_upper
        });
    }

    // Filter by status code
    if let Some(status_val) = status {
        filtered.retain(|req| {
            let req_status = req.get("status")
                .or_else(|| req.get("response").and_then(|r| r.get("status")))
                .and_then(|v| v.as_u64());

            if let Some(status_arr) = status_val.as_array() {
                status_arr.iter().any(|s| s.as_u64() == req_status)
            } else if let Some(s) = status_val.as_u64() {
                req_status == Some(s)
            } else {
                true
            }
        });
    }

    // Filter by resource type
    if let Some(rt) = resource_type {
        let types: Vec<&str> = if rt.contains(',') {
            rt.split(',').map(|s| s.trim()).collect()
        } else {
            vec![rt]
        };
        filtered.retain(|req| {
            let req_type = req.get("type")
                .or(req.get("resourceType"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            types.iter().any(|t| *t == req_type)
        });
    }

    // Filter by domain
    if let Some(d) = domain {
        filtered.retain(|req| {
            let url = req.get("url")
                .or_else(|| req.get("request").and_then(|r| r.get("url")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // Simple domain matching - check if hostname contains the domain
            url.contains(d)
        });
    }

    // Filter failed requests only
    if failed_only {
        filtered.retain(|req| {
            let status = req.get("status")
                .or_else(|| req.get("response").and_then(|r| r.get("status")))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            status >= 400 || status == 0
        });
    }

    filtered
}

/// Process request/response bodies: truncate or exclude based on flags.
pub fn process_request_bodies(
    request: &mut Value,
    include_response_bodies: bool,
    include_request_bodies: bool,
    max_body_size: usize,
) {
    // Handle response bodies
    if let Some(response) = request.get_mut("response") {
        if let Some(body) = response.get("body").and_then(|v| v.as_str()) {
            let body_len = body.len();
            if !include_response_bodies {
                if body_len > 0 {
                    if let Some(resp_obj) = response.as_object_mut() {
                        resp_obj.insert("body".to_string(), Value::String(
                            format!("[Response body excluded - {} chars. Set includeResponseBodies:true to include]", body_len)
                        ));
                        resp_obj.insert("bodySize".to_string(), Value::Number(body_len.into()));
                    }
                }
            } else if body_len > max_body_size {
                let (truncated, _) = super::truncation::truncate_string(body, max_body_size);
                if let Some(resp_obj) = response.as_object_mut() {
                    resp_obj.insert("body".to_string(), Value::String(truncated));
                }
            }
        }
    }

    // Handle request bodies
    if let Some(req_data) = request.get_mut("request") {
        if let Some(body) = req_data.get("body").and_then(|v| v.as_str()) {
            let body_len = body.len();
            if !include_request_bodies {
                if body_len > 0 {
                    if let Some(req_obj) = req_data.as_object_mut() {
                        req_obj.insert("body".to_string(), Value::String(
                            format!("[Request body excluded - {} chars. Set includeRequestBodies:true to include]", body_len)
                        ));
                        req_obj.insert("bodySize".to_string(), Value::Number(body_len.into()));
                    }
                }
            } else if body_len > max_body_size {
                let (truncated, _) = super::truncation::truncate_string(body, max_body_size);
                if let Some(req_obj) = req_data.as_object_mut() {
                    req_obj.insert("body".to_string(), Value::String(truncated));
                }
            }
        }
    }
}
