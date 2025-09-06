# Usage Examples

This document provides practical examples of how to use the Browser MCP Bridge with Claude Code.

## Basic Examples

### 1. Get Page Content

Extract complete page information from the current browser tab:

```bash
# Basic page content extraction
get_page_content

# Get content from specific tab
get_page_content --tabId 123

# Get content without metadata for faster processing
get_page_content --includeMetadata false
```

**Example Output:**
```json
{
  "url": "https://example.com",
  "title": "Example Domain",
  "text": "Example Domain\nThis domain is for use in illustrative examples...",
  "html": "<!doctype html><html><head><title>Example Domain</title>...",
  "metadata": {
    "viewport": "width=device-width, initial-scale=1",
    "description": "Example domain for documentation",
    "keywords": "example, domain, documentation"
  }
}
```

### 2. Execute JavaScript

Run JavaScript code in the browser page context:

```bash
# Get page title
execute_javascript --code "document.title"

# Get all links on the page
execute_javascript --code "Array.from(document.links).map(link => ({href: link.href, text: link.innerText}))"

# Check if jQuery is loaded
execute_javascript --code "typeof jQuery !== 'undefined' ? jQuery.fn.jquery : 'jQuery not found'"

# Get form data
execute_javascript --code "
Array.from(document.forms).map(form => ({
  action: form.action,
  method: form.method,
  fields: Array.from(form.elements).map(el => ({
    name: el.name,
    type: el.type,
    value: el.type !== 'password' ? el.value : '[HIDDEN]'
  }))
}))
"
```

### 3. Capture Screenshots

Take visual snapshots of the current page:

```bash
# Basic screenshot
capture_screenshot

# High quality PNG
capture_screenshot --format png --quality 100

# JPEG for smaller file size
capture_screenshot --format jpeg --quality 75
```

### 4. Analyze Performance

Get detailed performance metrics:

```bash
# Basic performance data
get_performance_metrics

# Analyze the results with Claude
"Based on these performance metrics, what optimizations would you recommend?"
```

## Advanced Examples

### Web Development Debugging

#### 1. Find and Fix Console Errors

```bash
# Get all console messages
get_console_messages

# Filter only errors
get_console_messages --types ["error"] --limit 10

# Analyze errors with Claude
"Review these JavaScript errors and suggest fixes"
```

#### 2. SEO Analysis

```bash
# Get page content for SEO analysis
get_page_content --includeMetadata true

# Then ask Claude:
"Analyze this page for SEO issues and suggest improvements for meta tags, headings, and content structure"
```

#### 3. Accessibility Audit

```bash
# Get accessibility tree
get_accessibility_tree

# Get DOM structure
get_dom_snapshot --includeStyles true

# Ask Claude to analyze:
"Review this page for accessibility issues and WCAG compliance"
```

### Form Testing and Analysis

#### 1. Extract Form Structure

```bash
execute_javascript --code "
Array.from(document.forms).map(form => {
  const formData = new FormData(form);
  return {
    name: form.name || 'unnamed',
    action: form.action,
    method: form.method,
    fields: Array.from(form.elements).map(field => ({
      name: field.name,
      type: field.type,
      required: field.required,
      placeholder: field.placeholder,
      value: field.type === 'password' ? '[HIDDEN]' : field.value
    }))
  };
})
"
```

#### 2. Test Form Validation

```bash
execute_javascript --code "
const form = document.querySelector('form');
const submitBtn = form.querySelector('[type=\"submit\"]');
const inputs = form.querySelectorAll('input[required]');

// Test required field validation
inputs.forEach(input => {
  input.value = '';
  input.reportValidity();
});

return {
  formValid: form.checkValidity(),
  invalidFields: Array.from(inputs).filter(input => !input.validity.valid).map(input => input.name)
};
"
```

### Content Scraping and Analysis

#### 1. Extract Article Content

```bash
execute_javascript --code "
const article = document.querySelector('article, [role=\"main\"], .content, .post');
if (article) {
  return {
    title: document.title,
    headings: Array.from(article.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(h => ({
      level: h.tagName,
      text: h.innerText
    })),
    content: article.innerText,
    wordCount: article.innerText.split(/\s+/).length,
    images: Array.from(article.querySelectorAll('img')).map(img => ({
      src: img.src,
      alt: img.alt
    }))
  };
} else {
  return { error: 'No article content found' };
}
"
```

#### 2. Extract Product Information

```bash
execute_javascript --code "
// E-commerce product extraction
const productSelectors = [
  '.product-title, .product-name, h1',
  '.price, .product-price, [class*=\"price\"]',
  '.description, .product-description',
  '.rating, .stars, [class*=\"rating\"]'
];

function extractBySelectors(selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element.innerText.trim();
  }
  return null;
}

return {
  title: extractBySelectors(['.product-title', '.product-name', 'h1']),
  price: extractBySelectors(['.price', '.product-price', '[class*=\"price\"]']),
  description: extractBySelectors(['.description', '.product-description']),
  rating: extractBySelectors(['.rating', '.stars', '[class*=\"rating\"]']),
  images: Array.from(document.querySelectorAll('img[src*=\"product\"], .product-image img')).map(img => img.src),
  availability: extractBySelectors(['.availability', '.stock', '[class*=\"stock\"]'])
};
"
```

### Performance Optimization

#### 1. Analyze Page Load Performance

```bash
# Get performance metrics
get_performance_metrics

# Get network requests
get_network_requests --limit 50

# Ask Claude:
"Based on these performance metrics and network requests, identify the main performance bottlenecks and suggest specific optimizations"
```

#### 2. Find Large Resources

```bash
execute_javascript --code "
const resources = performance.getEntriesByType('resource');
return resources
  .filter(r => r.transferSize > 100000) // > 100KB
  .sort((a, b) => b.transferSize - a.transferSize)
  .map(r => ({
    name: r.name,
    type: r.initiatorType,
    size: Math.round(r.transferSize / 1024) + 'KB',
    duration: Math.round(r.duration) + 'ms'
  }));
"
```

### Multi-Tab Workflows

#### 1. Compare Multiple Pages

```bash
# Get all open tabs
get_browser_tabs

# Analyze each tab (replace with actual tab IDs)
get_page_content --tabId 123
get_page_content --tabId 124
get_page_content --tabId 125

# Ask Claude:
"Compare these three pages for content quality, SEO, and user experience"
```

#### 2. Cross-Tab Data Collection

```bash
# Execute same script across multiple tabs
execute_javascript --tabId 123 --code "document.title + ' - ' + window.location.hostname"
execute_javascript --tabId 124 --code "document.title + ' - ' + window.location.hostname"
execute_javascript --tabId 125 --code "document.title + ' - ' + window.location.hostname"
```

## Real-World Scenarios

### Scenario 1: Debugging a Broken Contact Form

```bash
# Step 1: Check console for errors
get_console_messages --types ["error", "warn"]

# Step 2: Analyze form structure
execute_javascript --code "
const form = document.querySelector('form');
return {
  action: form.action,
  method: form.method,
  fields: Array.from(form.elements).map(el => ({
    name: el.name,
    type: el.type,
    required: el.required,
    value: el.value
  })),
  submitButton: form.querySelector('[type=\"submit\"]') ? true : false
};
"

# Step 3: Test form submission
execute_javascript --code "
const form = document.querySelector('form');
const formData = new FormData(form);
const data = {};
for (let [key, value] of formData.entries()) {
  data[key] = value;
}
return { formData: data, action: form.action, method: form.method };
"

# Step 4: Ask Claude to analyze and suggest fixes
```

### Scenario 2: SEO Audit of Blog Posts

```bash
# Extract blog post structure
execute_javascript --code "
const article = document.querySelector('article, .post, .entry, main');
return {
  title: document.title,
  h1Count: document.querySelectorAll('h1').length,
  headingStructure: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => ({
    tag: h.tagName,
    text: h.innerText.substring(0, 100)
  })),
  metaDescription: document.querySelector('meta[name=\"description\"]')?.content,
  wordCount: article ? article.innerText.split(/\s+/).length : 0,
  images: Array.from(document.querySelectorAll('img')).map(img => ({
    src: img.src,
    alt: img.alt || 'NO ALT TEXT',
    hasAlt: !!img.alt
  })),
  links: {
    internal: Array.from(document.links).filter(link => link.hostname === window.location.hostname).length,
    external: Array.from(document.links).filter(link => link.hostname !== window.location.hostname).length
  }
};
"

# Then ask: "Provide an SEO audit report with specific recommendations"
```

### Scenario 3: Mobile Responsiveness Testing

```bash
# Test different viewport sizes using debugger
attach_debugger --tabId 123

# Simulate mobile viewport (this would be done through debugger commands)
execute_javascript --code "
// Check if page is responsive
return {
  viewportWidth: window.innerWidth,
  viewportHeight: window.innerHeight,
  hasViewportMeta: !!document.querySelector('meta[name=\"viewport\"]'),
  viewportContent: document.querySelector('meta[name=\"viewport\"]')?.content,
  hasMediaQueries: Array.from(document.styleSheets).some(sheet => {
    try {
      return Array.from(sheet.cssRules).some(rule => 
        rule.type === CSSRule.MEDIA_RULE
      );
    } catch (e) {
      return false;
    }
  })
};
"

# Take screenshots at different sizes for comparison
capture_screenshot
```

## DevTools Panel Examples

### Using the Custom DevTools Panel

1. **Open DevTools**: Press F12 or right-click → Inspect
2. **Find MCP Bridge Tab**: Look for "MCP Bridge" tab
3. **Quick Actions**: Use the panel buttons for common tasks:
   - Capture Page Data
   - Capture DOM Snapshot  
   - Capture Console Messages
   - Take Screenshot

### Panel Automation

The DevTools panel provides quick access to:
- Connection status monitoring
- One-click data capture
- Real-time message logging
- Visual data inspection

## Integration with Claude Code Workflows

### Chain Multiple Tools

```bash
# Comprehensive page analysis
get_page_content && get_dom_snapshot && get_console_messages && get_performance_metrics

# Then ask: "Provide a complete technical analysis of this webpage including content quality, technical issues, and optimization recommendations"
```

### Conditional Tool Usage

```bash
# Check if page has forms before analyzing them
execute_javascript --code "document.forms.length > 0 ? 'has-forms' : 'no-forms'"

# If result is 'has-forms', then run form analysis scripts
```

### Data Export and Reporting

```bash
# Collect comprehensive data
get_page_content --includeMetadata true
get_network_requests --limit 100
get_console_messages --limit 50
get_performance_metrics

# Ask Claude to create a formatted report:
"Generate a comprehensive website analysis report in markdown format including executive summary, technical findings, and prioritized recommendations"
```

## Tips and Best Practices

### Performance Tips

1. **Limit Data Size**: Use `--limit` parameters to avoid overwhelming responses
2. **Filter Relevant Data**: Use `--types` filters for console messages
3. **Progressive Analysis**: Start with basic tools, then use advanced ones based on findings

### Security Considerations

1. **Avoid Sensitive Data**: Don't execute scripts that might expose passwords or tokens
2. **Validate URLs**: Ensure you're analyzing the intended pages
3. **Review Generated Code**: Always review JavaScript before execution

### Debugging Tips

1. **Check Connection**: Verify extension is connected before running tools
2. **Use DevTools Panel**: Monitor real-time communication
3. **Start Simple**: Test basic tools first, then progress to complex scenarios
4. **Check Console**: Look for error messages in browser and server logs