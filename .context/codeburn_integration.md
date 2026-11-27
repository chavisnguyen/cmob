# codeburn integration (Usage tab "Spend" section)

Goal: show day/month token cost (what the user sees in the cmux tab running `bunx codeburn`) inside the cmob Usage tab.

## Verified facts (run locally on 2026-11-27, `bunx codeburn@0.9.28`)
- `codeburn --help` lists `status`, `export`, `report`, `today`, `month`, `quota`, `serve`, `mcp`, ...
- `codeburn status --format json` → `{"currency","today":{cost,savings,calls},"month":{...}}` (too coarse).
- `codeburn status --format menubar-json --period <today|week|30days|month|all|lifetime> [--day|--from|--to|--days] [--no-optimize] [--no-timeline]`
  prints one JSON doc. Keys used: `current.{label,cost,calls,sessions,cacheHitPercent,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,topModels[],providerDetails[],topProjects[]}`,
  `history.daily[]` (96 entries observed; `{date,cost,calls,*Tokens,topModels}`), `periodTotals.{today,week,month}`, `currency.{code,symbol,rate}`.
- Timing (cold, this Mac): today ≈2.1s, week ≈2.9s, month ≈4.6s; payload 60–80 KB with `--no-optimize --no-timeline`.
- README: pricing from LiteLLM (cached 24h); daily history kept in `~/.cache/codeburn/`; prompts/code never leave the machine. Requires Node ≥ 22.15.

## Implementation
- Gateway: `repos/cmux-gateway/src/services/spend.rs` (`SpendService`), RPC `mobile.usage.spend` (`protocol/rpc.rs`, handler in `transport/rpc/host_tools.rs`).
  - params: `{period: today|week|30days|month (whitelisted; reaches argv), refresh?: bool}`; unknown period → invalid_params.
  - result: `{status: ok|unavailable|error, error?, data?: SpendData, updated_at}`; trimmed (31 days, top 8 models/projects).
  - Runner order: `CMUX_CODEBURN_BIN` → `codeburn` on PATH / brew / `~/.bun/bin` → `bunx codeburn@0.9.28` (pinned). 40s timeout, 60s per-period cache, single-flight, failed refresh never evicts a good cached result.
- Client: `repos/cmux-client/src/components/usage/{SpendSection,useSpendSnapshot,spendFormatting}.ts(x)`, rendered under quota cards in `UsageView`; types in `protocol/rpc.ts`; demo data in `demo/demoMode.ts`.
- Tests: `cargo test spend` (parser on sample shaped from live output; `CODEBURN_SAMPLE=<file>` / `CODEBURN_LIVE=1` opt-in live checks), `vp test run src/components/usage`.

## Open items
- [HYPOTHESIS - UNVERIFIED] Whether `cost` values are converted by `currency.rate` for non-USD currencies. Verify: `codeburn currency EUR && codeburn status --format menubar-json --period today | jq '.current.cost, .currency'`, compare with USD value (then `codeburn currency USD`).
- Not yet exposed: `codeburn quota`, `optimize` findings, `--day/--from/--to` custom ranges.
