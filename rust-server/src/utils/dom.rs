use serde_json::Value;

/// Truncate a DOM tree to max_nodes, replacing excess subtrees with sentinel nodes.
/// Returns (truncated_tree, nodes_counted, was_truncated).
pub fn truncate_dom_tree(node: &Value, max_nodes: usize, current_count: &mut usize) -> Value {
    if !node.is_object() || *current_count >= max_nodes {
        return serde_json::json!({ "truncated": true, "reason": "Max nodes reached" });
    }

    *current_count += 1;

    let mut result = serde_json::Map::new();

    // Copy tag
    if let Some(tag) = node.get("tag").or(node.get("tagName")) {
        result.insert("tag".to_string(), tag.clone());
    }

    // Copy attributes
    if let Some(attrs) = node.get("attributes") {
        result.insert("attributes".to_string(), attrs.clone());
    }

    // Truncate text content
    if let Some(text) = node.get("text").and_then(|v| v.as_str()) {
        if text.len() > 500 {
            let (truncated, _) = super::truncation::truncate_string(text, 500);
            result.insert("text".to_string(), Value::String(truncated));
        } else {
            result.insert("text".to_string(), Value::String(text.to_string()));
        }
    }

    // Copy other useful fields
    for key in &["nodeType", "node_type", "role", "name", "value", "xpath", "selector"] {
        if let Some(v) = node.get(key) {
            result.insert(key.to_string(), v.clone());
        }
    }

    // Process children
    if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
        if !children.is_empty() && *current_count < max_nodes {
            let mut new_children = Vec::new();
            for child in children {
                if *current_count >= max_nodes {
                    new_children.push(serde_json::json!({
                        "truncated": true,
                        "remainingChildren": children.len() - new_children.len()
                    }));
                    break;
                }
                new_children.push(truncate_dom_tree(child, max_nodes, current_count));
            }
            result.insert("children".to_string(), Value::Array(new_children));
        }
    }

    Value::Object(result)
}

/// Filter DOM tree to remove <script> and/or <style> tags.
pub fn filter_dom_tree(node: &Value, exclude_scripts: bool, exclude_styles: bool) -> Option<Value> {
    if !node.is_object() {
        return Some(node.clone());
    }

    let tag_lower = node.get("tag")
        .or(node.get("tagName"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();

    if exclude_scripts && tag_lower == "script" {
        return None;
    }
    if exclude_styles && tag_lower == "style" {
        return None;
    }

    let mut result = node.clone();

    if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
        let filtered_children: Vec<Value> = children
            .iter()
            .filter_map(|child| filter_dom_tree(child, exclude_scripts, exclude_styles))
            .collect();
        result["children"] = Value::Array(filtered_children);
    }

    Some(result)
}

/// Filter DOM tree by CSS selector (basic: .class, #id, tag).
/// Returns the first matching node.
pub fn filter_dom_by_selector(node: &Value, selector: &str) -> Option<Value> {
    if !node.is_object() || selector.is_empty() {
        return Some(node.clone());
    }

    let matches = |n: &Value| -> bool {
        let attrs = n.get("attributes");

        if selector.starts_with('.') {
            // Class selector
            let class_name = &selector[1..];
            if let Some(node_classes) = attrs.and_then(|a| a.get("class")).and_then(|v| v.as_str()) {
                return node_classes.split_whitespace().any(|c| c == class_name);
            }
            return false;
        }

        if selector.starts_with('#') {
            // ID selector
            let id = &selector[1..];
            if let Some(node_id) = attrs.and_then(|a| a.get("id")).and_then(|v| v.as_str()) {
                return node_id == id;
            }
            return false;
        }

        // Tag selector
        let tag = n.get("tag")
            .or(n.get("tagName"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        tag.eq_ignore_ascii_case(selector)
    };

    if matches(node) {
        return Some(node.clone());
    }

    // Search children
    if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
        for child in children {
            if let Some(found) = filter_dom_by_selector(child, selector) {
                return Some(found);
            }
        }
    }

    None
}

/// Remove styles and computedStyles fields from DOM tree recursively.
pub fn remove_styles_from_dom_tree(node: &mut Value) {
    if let Some(obj) = node.as_object_mut() {
        obj.remove("styles");
        obj.remove("computedStyles");
        obj.remove("computed_styles");

        if let Some(children) = obj.get_mut("children") {
            if let Some(arr) = children.as_array_mut() {
                for child in arr {
                    remove_styles_from_dom_tree(child);
                }
            }
        }
    }
}
