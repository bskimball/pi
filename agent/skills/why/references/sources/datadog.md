# Datadog Telemetry

## What this source contains

Datadog holds the runtime record, what actually happened in production, as opposed to what was planned or discussed.

- **Metrics.** Counters, gauges, histograms instrumented by the team. A metric's *presence* is itself evidence. Someone thought this number worth watching.
- **Monitors & alerts.** Conditions the team decided warranted waking someone up. A monitor firing on `rate_limit_hit > 10/min` is direct evidence the team worried about that threshold.
- **Dashboards.** Curated views. The charts tell you what the team considers important for a subsystem.
- **APM traces & spans.** Request-level runtime data. Useful for "why is this slow" / "why is there a timeout here" questions.
- **Logs.** High-volume event records. Often contain the error conditions that motivated defensive code.
- **Incidents.** Formal incident records with timelines and linked postmortems.
- **Notebooks.** Exploratory investigations. Often contain hypotheses and analyses.

Datadog answers "what was the production reality around the time this code was written?", which often explains the code's shape.

## How to search it

Use this source only when reachable through an authenticated read-only interface. Discover MCP tools via `tool_search` when available or Pi codemode discovery; CLIs and `web_search`/`fetch_content` are alternatives. Inspect actual schemas or CLI help before invoking anything. If absent or inaccessible, report a coverage gap; the evidence types and pitfalls below still apply.

Start broad, then narrow using the reachable telemetry interface.

1. Identify the owning services and their upstream/downstream dependencies.
2. Search dashboards and monitors by feature, service, and symbol. Record the queries and watched thresholds; they often explain a clamp or limit.
3. Find relevant metrics and inspect descriptions, units, and tags. Compare time series with the code's change date, looking for spikes before and stabilization after.
4. Search logs by symbols, error strings, and feature names, narrowly bounded by service, tags, and time. Prefer aggregate counts or log patterns over raw dumps.
5. Inspect spans and traces for timeout, retry, slow-path, and cross-service evidence. Aggregate failure rates, then inspect representative trace IDs.
6. Search incident titles, teams, and dates around defensive-code changes. Read complete incident timelines and linked postmortems.

Strongly prefer bounded windows, initially about 30 days before and after the change. Record exact queries, scope, and retention limits.

## What good evidence looks like here

- A monitor whose query and threshold match the constraint the code enforces (code clamps to 100, monitor alerts when requests exceed 100/min)
- A dashboard created by the target's author, with widgets that correspond to what the code measures or guards against
- A metric showing a production spike immediately before the code was merged, and stable values after
- An incident record referencing the target code, the same symbols, or the same error strings
- Logs showing a specific error pattern the defensive code would prevent, timestamped in the window before the change

## Common pitfalls

- **Correlation is not causation.** A spike before a PR and stabilization after is suggestive, not definitive. Other changes may have landed in the same window. Check neighboring PRs.
- **Overfitting to the chart you found.** Datadog visualizations are *made* by humans and reflect that human's framing. A chart named "retry success rate" is evidence the team cared about retry success, not that it's why a specific line of code exists.
- **Vanished telemetry.** Metrics can be renamed, deleted, or have short retention. If you can't find data from the relevant window, that's a gap, not a null result.
- **Noise at scale.** Searching logs for a common string returns thousands of matches. Narrow by service, tag, and time aggressively. Use read-only aggregation rather than dumping raw logs.
- **Instrumented != caused.** A metric's existence tells you someone cared enough to measure something, not that the code was added *because* of it. Cross-reference with commit/PR dates.

## What to return

For each relevant item:
- Type (dashboard / monitor / metric / log pattern / trace / incident / notebook)
- Title or name
- Link or identifier (dashboard ID, monitor ID, metric name, incident ID)
- Owner/author and created/modified date
- The specific condition, query, or quote that bears on the question (verbatim where possible)
- Relevance: what this suggests about the target code, and how strong the connection is
