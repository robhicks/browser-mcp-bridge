pub const MAX_HTML_SIZE: usize = 50000;
pub const MAX_TEXT_SIZE: usize = 30000;
pub const MAX_DOM_NODES: usize = 500;
pub const MAX_REQUEST_BODY_SIZE: usize = 10000;
pub const MAX_RESPONSE_BODY_SIZE: usize = 10000;
pub const MAX_CONSOLE_MESSAGES: usize = 50;
pub const MAX_NETWORK_REQUESTS: usize = 50;
pub const MAX_RESPONSE_SIZE: usize = 100000;

/// Truncate a string to max_len, appending a truncation indicator.
/// Returns (truncated_string, was_truncated).
pub fn truncate_string(s: &str, max_len: usize) -> (String, bool) {
    if s.len() <= max_len {
        return (s.to_string(), false);
    }
    let truncated = &s[..max_len];
    let indicator = format!(
        "\n... [TRUNCATED - original size: {}]",
        s.len()
    );
    (format!("{}{}", truncated, indicator), true)
}
