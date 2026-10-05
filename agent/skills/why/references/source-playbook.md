# Source playbooks

Use whichever of these sources are reachable (MCP tools via `tool_search` when available, CLIs, `web_search`/`fetch_content`, git history). In Pi, use codemode discovery when native MCP tools are not directly listed. Inspect the real interface before calling it; no service or tool is assumed installed.

The why method searches each reachable evidence category with disjoint read-only source scopes, or inline in Work mode. These playbooks describe evidence, search strategies, and pitfalls that remain useful without a particular MCP. Adapt queries to the discovered interface, and record unavailable sources as coverage gaps.

| Category | Playbook | Example source (not a dependency) |
|---|---|---|
| Source control history | [`code-archaeology.md`](./sources/code-archaeology.md) | git, `gh` |
| Issue / ticket tracker | [`linear.md`](./sources/linear.md) | Linear (adapt for Jira, GitHub Issues, Plane, Shortcut) |
| Long-form documents | [`notion.md`](./sources/notion.md) | Notion (adapt for Confluence, Google Docs, Coda) |
| Real-time team chat | [`slack.md`](./sources/slack.md) | Slack (adapt for Discord, Microsoft Teams, Mattermost) |
| Infrastructure observability | [`datadog.md`](./sources/datadog.md) | Datadog (adapt for New Relic, Honeycomb, Grafana, Splunk) |
| Error / exception tracking | [`sentry.md`](./sources/sentry.md) | Sentry (adapt for Rollbar, Bugsnag, Airbrake) |
| Product analytics warehouse | [`databricks.md`](./sources/databricks.md) | Databricks SQL (adapt for Snowflake, BigQuery, ClickHouse, dbt) |

Cross-cutting:

- [`incident-postmortem.md`](./sources/incident-postmortem.md). Add this if the target code looks defensive (null checks, retry, timeout, rate limit, feature flag, egress guard, OOM handler).
