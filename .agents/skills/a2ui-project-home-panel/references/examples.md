# A2UI Home Panel Examples

## Paper Daily Dashboard

Data model shape:

```json
{
  "metrics": {
    "paperCount": "2195",
    "reportCount": "70",
    "dateRange": "2026-01-01 to 2026-05-12"
  },
  "latestReport": {
    "title": "情报日报 2026-05-17",
    "path": "reports/2026-05-17.md",
    "summary": "未标注：AI 产品跳过了撤销设计..."
  },
  "topicBars": [
    "Agents      ████████░░  42",
    "Search      ██████░░░░  31",
    "Security    ████░░░░░░  18"
  ]
}
```

Component pattern:

```json
[
  { "id": "root", "component": "Column", "children": ["metrics-row", "latest-report-card", "topics-card"] },
  { "id": "metrics-row", "component": "Row", "children": ["paper-card", "report-card", "range-card"] },
  { "id": "paper-card", "component": "Card", "child": "paper-card-body" },
  { "id": "paper-card-body", "component": "Column", "children": ["paper-label", "paper-value"] },
  { "id": "paper-label", "component": "Text", "variant": "caption", "text": "论文总数" },
  { "id": "paper-value", "component": "Text", "variant": "h2", "text": { "path": "/metrics/paperCount" } },
  { "id": "latest-report-card", "component": "Card", "child": "latest-report-body" },
  { "id": "latest-report-body", "component": "Column", "children": ["latest-report-title", "latest-report-summary", "latest-report-open"] },
  { "id": "latest-report-title", "component": "Text", "variant": "h3", "text": { "path": "/latestReport/title" } },
  { "id": "latest-report-summary", "component": "Text", "text": { "path": "/latestReport/summary" } },
  { "id": "latest-report-open", "component": "Button", "child": "latest-report-open-label", "variant": "borderless", "action": { "event": { "name": "open_file", "context": { "filePath": { "path": "/latestReport/path" } } } } },
  { "id": "latest-report-open-label", "component": "Text", "text": { "path": "/latestReport/path" } }
]
```

## Code Project Dashboard

Useful cards:

- `Package scripts`: list available scripts and highlight missing test/typecheck.
- `Recent files`: latest modified source/config files with `open_file`.
- `Project health`: README/TODO/env/config presence.
- `File distribution`: text bar list by extension or top directories.

## SQLite Dashboard

Useful cards:

- Table count and row counts.
- Latest records from the most relevant table.
- Status/category distribution.
- Null/missing required fields.
- Database source card with `open_file`.
