# openclaw-anthropic-oauth

OpenClaw provider plugin that uses **Claude Max subscription** via OAuth access + refresh tokens with automatic token refresh.

## What it does

- Registers provider `anthropic-oauth` with models `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`
- Accepts any `claude-*` model ID dynamically — no plugin update needed for new releases
- Auto-refreshes expired access tokens via the refresh token
- Injects required billing metadata and OAuth beta headers

## Install

```bash
openclaw plugins install github:evgeniyg-0hub/openclaw-anthropic-oauth
```

## Setup

### 1. Get fresh tokens from Claude Code

Before extracting tokens, do a clean re-login to make sure they are fresh:

**macOS:**
```bash
# 1. Delete old credentials from Keychain
security delete-generic-password -s "Claude Code-credentials"

# 2. Re-login in Claude Code
claude logout 2>/dev/null; claude

# 3. Complete the OAuth login in the browser, then exit Claude Code

# 4. Extract fresh tokens
security find-generic-password -s "Claude Code-credentials" -w | \
  python3 -c "import json,sys; d=json.loads(sys.stdin.read())['claudeAiOauth']; print(f'Access: {d[\"accessToken\"]}\nRefresh: {d[\"refreshToken\"]}')"
```

**Linux:**
```bash
# 1. Delete old credentials
rm -f ~/.claude/.credentials.json

# 2. Re-login
claude

# 3. Complete OAuth login, then exit Claude Code

# 4. Extract tokens
python3 -c "import json; d=json.load(open('$HOME/.claude/.credentials.json'))['claudeAiOauth']; print(f'Access: {d[\"accessToken\"]}\nRefresh: {d[\"refreshToken\"]}')"
```

### 2. Add tokens to OpenClaw

**Interactive:**
```bash
openclaw models auth login --provider anthropic-oauth --method oauth-tokens
```

**Non-interactive:**
```bash
openclaw models auth login --provider anthropic-oauth --method oauth-tokens \
  --anthropic-access-token "sk-ant-oat01-..." \
  --anthropic-refresh-token "sk-ant-ort01-..."
```

### 3. Set as default model

In `~/.openclaw/openclaw.json`:
```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic-oauth/claude-opus-4-6"
      }
    }
  }
}
```

Then restart the gateway:
```bash
openclaw gateway restart
```

### 4. Re-login Claude Code after setup

OpenClaw and Claude Code share the same OAuth tokens. After transferring tokens to OpenClaw, re-login Claude Code so each has its own independent token pair:

**macOS:**
```bash
security delete-generic-password -s "Claude Code-credentials"
claude  # will prompt for fresh login
```

**Linux:**
```bash
rm -f ~/.claude/.credentials.json
claude  # will prompt for fresh login
```

This prevents token conflicts — each tool will refresh its own tokens independently.

## How it works

1. OAuth tokens (`sk-ant-oat01-*` access + `sk-ant-ort01-*` refresh) are stored in OpenClaw's auth-profiles
2. When access token expires, the plugin automatically refreshes it via `https://platform.claude.com/v1/oauth/token`
3. Each request includes billing metadata in the system prompt (required by Anthropic for OAuth-based access to Opus/Sonnet)
4. OAuth beta headers (`oauth-2025-04-20`, `claude-code-20250219`) are injected automatically

## Token types

| Token | Prefix | Purpose | Lifetime |
|-------|--------|---------|----------|
| Access token | `sk-ant-oat01-` | API authentication | ~1 hour (auto-refreshed) |
| Refresh token | `sk-ant-ort01-` | Renew access token | ~1 year |

## Disclaimer

This plugin relies on reverse-engineered billing metadata from Claude Code CLI. Anthropic may change the required format at any time, which could break this plugin. The OAuth Client ID used is the same public ID used by all Claude Code installations.

## License

MIT
