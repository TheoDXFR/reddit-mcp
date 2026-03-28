# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build   # Compile TypeScript → dist/index.js
npm run dev     # Watch mode (tsc --watch)
npm start       # Run compiled server (stdio mode)
```

No test or lint commands are configured.

## Architecture

Single-file TypeScript MCP server: all logic lives in `src/index.ts` (~770 lines). Compiled output goes to `dist/index.js`.

### Dual-mode operation

- **Stdio mode** (default, no `PORT` env var): connects directly to Claude Desktop via stdin/stdout
- **HTTP mode** (`PORT` env var set): Express.js server with gzip compression, session management, used for Railway/Cloud Run deployment; MCP endpoints at `/mcp`, health check at `/`

### MCP tools exposed (7 total)

1. `get_subreddit_posts` — fetch posts by sort (hot/new/top/rising); supports `before`/`after` pagination and `time` filter for all sorts
2. `get_post_with_comments` — full post + comment tree; configurable `depth` (1-10, default 6)
3. `search_reddit` — search across Reddit or a specific subreddit; supports `type` filter (link/self/comment/sr) and `before`/`after` pagination
4. `get_subreddit_info` — subreddit metadata
5. `get_user_posts` — user's posts and comments
6. `search_web` — web search via Tavily API (requires `TAVILY_API_KEY`); supports `max_results`, `search_depth`, `topic`
7. `search_docs` — official docs via Context7 HTTP API (no key required; `CONTEXT7_API_KEY` optional for higher limits); supports `library`, `query`, `max_tokens`

### Reddit API

Direct HTTPS calls to `https://www.reddit.com` (anonymous) or `https://oauth.reddit.com` when `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` are set. Responses are parsed by `parsePost()` and `parseComment()` (recursive, max depth 6 by default), then formatted as Markdown. Cache keys built with `ck()` helper (escapes `:` to prevent collisions).

### RedditPost fields

`id`, `title`, `author`, `subreddit`, `score`, `upvote_ratio`, `num_comments`, `permalink`, `selftext`, `created_date`, `link_flair_text`, `over_18`, `stickied`, `locked`, `is_video`, `post_hint`, `domain`, `total_awards_received`, `crosspost_parent`

### Output language

All user-facing strings, error messages, and formatted output are in **French**.

## Optimizations (v2.0.0)

- **In-memory cache** with TTL per endpoint: subreddit info (10 min), posts (5 min), search (2 min), post+comments (5 min), user (3 min), docs/Context7 (30 min)
- **Cache key safety**: `ck()` helper escapes `:` in all key parts to prevent collision
- **Request deduplication**: concurrent identical requests share a single in-flight fetch
- **Retry with backoff**: 3 attempts on 429/5xx; respects `retry-after` header; no double-sleep (flag `prevWas429`)
- **Proactive rate limiting**: parses `x-ratelimit-remaining`/`x-ratelimit-reset` headers; pauses automatically when < 5 requests remain
- **Reddit OAuth2** (app-only): set `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` for 60 req/min; auto token refresh with 5-min safety buffer
- **Session cleanup**: HTTP sessions idle >1h are purged automatically; race condition fixed via `newSession` closure
- **Gzip compression**: HTTP mode uses `compression()` middleware for ~50% smaller responses
- Health endpoint (`GET /`) returns `version`, `uptime_s`, `cache_entries`, `reddit_oauth`, `tavily_configured`, `context7_configured`, `rate_limit_remaining`

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Enable HTTP mode on this port |
| `REDDIT_CLIENT_ID` | No | Reddit OAuth app ID for higher rate limits |
| `REDDIT_CLIENT_SECRET` | No | Reddit OAuth app secret |
| `TAVILY_API_KEY` | For search_web | Tavily Search API key |
| `CONTEXT7_API_KEY` | No | Context7 key for higher rate limits (free without) |

## Deployment

### Cloud Run (sparx project — primary)

Service: `reddit-mcp` in `europe-west1`, project `sparx-8ed14`.
URL: `https://reddit-mcp-580156909195.europe-west1.run.app`

```bash
# Deploy (builds via Cloud Build + Artifact Registry)
gcloud run deploy reddit-mcp --source . --project sparx-8ed14 --region europe-west1 --no-allow-unauthenticated

# Test with OAuth identity token
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" https://reddit-mcp-580156909195.europe-west1.run.app/

# Add Reddit OAuth credentials for higher rate limits
gcloud run services update reddit-mcp --project sparx-8ed14 --region europe-west1 \
  --update-env-vars "REDDIT_CLIENT_ID=xxx,REDDIT_CLIENT_SECRET=yyy"

# Add Tavily + Context7 keys
gcloud run services update reddit-mcp --project sparx-8ed14 --region europe-west1 \
  --update-env-vars "TAVILY_API_KEY=tvly-xxx,CONTEXT7_API_KEY=c7-xxx"

# Grant access to another user
gcloud run services add-iam-policy-binding reddit-mcp --project sparx-8ed14 --region europe-west1 \
  --member="user:someone@gmail.com" --role="roles/run.invoker"
```

**OAuth**: `--no-allow-unauthenticated` — callers must include `Authorization: Bearer <google-identity-token>`. Get a token with `gcloud auth print-identity-token`.

### Railway (legacy)
`railway.json` configures Railway.app: build runs `npm run build && npm start`, health check hits `GET /`.
