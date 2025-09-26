use crate::types::{browser::PageContent, errors::*, messages::*};

/// Page content extraction utilities
pub struct PageContentTool;

impl PageContentTool {
    pub fn validate_request(tab_id: Option<u32>, include_metadata: bool) -> Result<()> {
        if let Some(tab_id) = tab_id {
            if tab_id == 0 {
                return Err(BrowserMcpError::InvalidParameters {
                    message: "Tab ID must be greater than 0".to_string(),
                });
            }
        }
        Ok(())
    }

    pub fn create_request(include_metadata: bool) -> BrowserRequest {
        BrowserRequest::GetPageContent { include_metadata }
    }

    pub fn format_response(content: &PageContent, include_metadata: bool) -> serde_json::Value {
        let mut result = serde_json::json!({
            "url": content.url,
            "title": content.title,
            "text": content.text,
        });

        if include_metadata {
            result["html"] = serde_json::Value::String(content.html.clone());
            result["metadata"] = serde_json::to_value(&content.metadata).unwrap_or(serde_json::Value::Null);
            result["lastUpdated"] = serde_json::Value::String(
                content.last_updated
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
                    .to_string()
            );
        }

        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_validate_request() {
        assert!(PageContentTool::validate_request(Some(1), true).is_ok());
        assert!(PageContentTool::validate_request(None, false).is_ok());
        assert!(PageContentTool::validate_request(Some(0), true).is_err());
    }

    #[test]
    fn test_create_request() {
        let request = PageContentTool::create_request(true);
        match request {
            BrowserRequest::GetPageContent { include_metadata } => {
                assert!(include_metadata);
            }
            _ => panic!("Unexpected request type"),
        }
    }

    #[test]
    fn test_format_response() {
        let content = PageContent {
            url: "https://example.com".to_string(),
            title: "Test Page".to_string(),
            text: "Test content".to_string(),
            html: "<html>Test</html>".to_string(),
            metadata: HashMap::new(),
            last_updated: std::time::SystemTime::now(),
        };

        let response = PageContentTool::format_response(&content, true);
        assert_eq!(response["url"], "https://example.com");
        assert_eq!(response["title"], "Test Page");
        assert!(response["html"].is_string());
        assert!(response["metadata"].is_object());

        let response_no_metadata = PageContentTool::format_response(&content, false);
        assert!(response_no_metadata["html"].is_null());
    }
}