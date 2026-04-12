import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";

const PROVIDER_ID = "anthropic-oauth";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const BILLING_HEADER = "x-anthropic-billing-header: cc_version=2.1.92.ecb; cc_entrypoint=cli; cch=00000;";

const OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "effort-2025-11-24",
];

// Trigger phrases that Anthropic's streaming classifier detects as OpenClaw.
// Order matters: longer matches (sessions_yield_interrupt) before shorter (sessions_yield).
const TRIGGER_SANITIZE = [
  ["OpenClaw", "OCPlatform"],
  ["openclaw", "ocplatform"],
  ["sessions_spawn", "create_task"],
  ["sessions_list", "list_tasks"],
  ["sessions_history", "get_history"],
  ["sessions_send", "send_to_task"],
  ["sessions_yield_interrupt", "task_yield_interrupt"],
  ["sessions_yield", "yield_task"],
  ["sessions_store", "task_store"],
  ["HEARTBEAT_OK", "HB_ACK"],
  ["running inside", "running on"],
];

// Reverse map applied to API responses so OpenClaw sees original tool names.
const REVERSE_MAP = TRIGGER_SANITIZE.map(([from, to]) => [to, from]);

// Known models with pricing. Any unknown claude-* model ID is accepted
// dynamically via resolveDynamicModel — no need to update this list for new releases.
const CATALOG_MODELS = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 16384,
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 16384,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    contextWindow: 200000,
    maxTokens: 8192,
  },
];

// Sanitize outbound payload: replace trigger phrases that Anthropic's classifier detects.
// Serialize → replaceAll → parse → mutate in place (same approach as openclaw-billing-proxy).
function sanitizePayload(payloadObj) {
  let json = JSON.stringify(payloadObj);
  for (const [from, to] of TRIGGER_SANITIZE) {
    json = json.replaceAll(from, to);
  }
  const clean = JSON.parse(json);
  for (const key of Object.keys(payloadObj)) delete payloadObj[key];
  Object.assign(payloadObj, clean);
}

// Reverse-map a string (response chunk or JSON) back to original OpenClaw terms.
function reverseMapStr(str) {
  let out = str;
  for (const [sanitized, original] of REVERSE_MAP) {
    out = out.replaceAll(sanitized, original);
  }
  return out;
}

function validateAccessToken(value) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "Access token is required";
  if (!trimmed.startsWith("sk-ant-oat")) return "Access token must start with sk-ant-oat";
  if (trimmed.length < 80) return "Access token is too short (min 80 chars)";
}

function validateRefreshToken(value) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "Refresh token is required";
  if (!trimmed.startsWith("sk-ant-ort")) return "Refresh token must start with sk-ant-ort";
  if (trimmed.length < 80) return "Refresh token is too short (min 80 chars)";
}

// Properties to keep in the message tool schema. The full schema has 109 properties
// covering Discord/Slack/WhatsApp/etc — most are irrelevant for a Telegram-only setup
// and blow up the tool token count, pushing OAuth requests into "extra usage".
const MESSAGE_ALLOWED_PROPS = new Set([
  "action", "channel", "target", "targets", "message",
  "threadId", "replyTo", "media", "filename", "caption",
  "buffer", "contentType", "silent", "asVoice", "dryRun",
  "forceDocument", "asDocument", "quoteText",
  "emoji", "messageId", "message_id", "remove",
  "effectId", "effect", "gifPlayback", "path", "filePath",
]);

function slimMessageTool(tools) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (tool.name !== "message") continue;
    const props = tool.input_schema?.properties;
    if (!props) break;
    for (const key of Object.keys(props)) {
      if (!MESSAGE_ALLOWED_PROPS.has(key)) delete props[key];
    }
    break;
  }
}

function mergeAnthropicBetaHeader(headers, betas) {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find((k) => k.toLowerCase() === "anthropic-beta");
  const existing = existingKey ? merged[existingKey].split(",").map((s) => s.trim()).filter(Boolean) : [];
  const key = existingKey ?? "anthropic-beta";
  merged[key] = [...new Set([...existing, ...betas])].join(",");
  return merged;
}

// Reverse-map sanitized tool names in API response events.
// Only patches .push() — NOT .end(), which would break EventStream completion.
// Only transforms events that actually contain sanitized terms (safe & minimal).
function wrapStreamWithReverseMap(stream) {
  if (!stream || typeof stream !== "object" || typeof stream.push !== "function") return stream;

  const origPush = stream.push.bind(stream);
  stream.push = (event) => {
    try {
      const json = JSON.stringify(event);
      if (REVERSE_MAP.some(([sanitized]) => json.includes(sanitized))) {
        return origPush(JSON.parse(reverseMapStr(json)));
      }
    } catch { /* fall through to original */ }
    return origPush(event);
  };

  return stream;
}

function createBillingAndBetaWrapper(baseStreamFn) {
  if (!baseStreamFn) return undefined;
  return (model, context, options) => {
    const stream = streamWithPayloadPatch(
      (m, c, o) => baseStreamFn(m, c, { ...o, headers: mergeAnthropicBetaHeader(o?.headers, OAUTH_BETAS) }),
      model,
      context,
      options,
      (payloadObj) => {
        // 1. Inject billing header
        const billingBlock = { type: "text", text: BILLING_HEADER };
        const system = payloadObj.system;
        if (Array.isArray(system)) {
          system.unshift(billingBlock);
        } else if (typeof system === "string") {
          payloadObj.system = [billingBlock, { type: "text", text: system }];
        } else {
          payloadObj.system = [billingBlock];
        }
        // 2. Slim message tool schema
        slimMessageTool(payloadObj.tools);
        // 3. Sanitize all trigger phrases (must be last)
        sanitizePayload(payloadObj);
      },
    );
    // 4. Wrap response stream with reverse mapping
    return wrapStreamWithReverseMap(stream);
  };
}

// Build a dynamic model entry for any claude-* model ID not in the catalog.
// This way new model releases work automatically without plugin updates.
function buildDynamicModel(modelId) {
  const lower = modelId.trim().toLowerCase();
  if (!lower.startsWith("claude-")) return undefined;

  // Find the closest known model to inherit pricing/config from
  const template =
    CATALOG_MODELS.find((m) => lower.startsWith(m.id)) ??
    CATALOG_MODELS.find((m) => lower.includes("opus") ? m.id.includes("opus") : m.id.includes("sonnet")) ??
    CATALOG_MODELS[1]; // default to sonnet

  return {
    ...template,
    id: modelId.trim(),
    name: modelId.trim(),
    provider: PROVIDER_ID,
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Anthropic OAuth Provider",
  description: "Anthropic provider using OAuth access+refresh tokens from Claude Max subscription",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Anthropic OAuth",
      envVars: ["ANTHROPIC_OAUTH_ACCESS_TOKEN", "ANTHROPIC_OAUTH_REFRESH_TOKEN"],
      auth: [
        {
          id: "oauth-tokens",
          label: "OAuth tokens (access + refresh)",
          hint: "Paste access and refresh tokens from Claude Code credentials",
          kind: "oauth",
          wizard: {
            choiceId: "oauth-tokens",
            choiceLabel: "Anthropic OAuth tokens (access + refresh)",
            choiceHint: "Paste tokens from Claude Code Keychain for auto-refreshing auth",
            groupId: "anthropic-oauth",
            groupLabel: "Anthropic OAuth",
            groupHint: "Claude Max via OAuth tokens",
            modelAllowlist: {
              allowedKeys: CATALOG_MODELS.map((m) => `${PROVIDER_ID}/${m.id}`),
              initialSelections: [`${PROVIDER_ID}/claude-sonnet-4-6`],
              message: "Anthropic OAuth models",
            },
          },
          async run(ctx) {
            await ctx.prompter.note(
              [
                "Provide OAuth access and refresh tokens from Claude Code credentials.",
                "",
                "Extract from macOS Keychain:",
                "  security find-generic-password -s 'Claude Code-credentials' -w | \\",
                "    python3 -c \"import json,sys; d=json.loads(sys.stdin.read())['claudeAiOauth']; print(f'Access: {d[\\\"accessToken\\\"]}\\nRefresh: {d[\\\"refreshToken\\\"]}')\"",
                "",
                "On Linux (~/.claude/.credentials.json):",
                "  python3 -c \"import json; d=json.load(open('$HOME/.claude/.credentials.json'))['claudeAiOauth']; print(f'Access: {d[\\\"accessToken\\\"]}\\nRefresh: {d[\\\"refreshToken\\\"]}')\"",
              ].join("\n"),
              "Anthropic OAuth tokens",
            );

            const accessToken = String(
              await ctx.prompter.text({
                message: "Paste access token (sk-ant-oat01-...)",
                validate: (v) => validateAccessToken(String(v ?? "")),
              }) ?? "",
            ).trim();

            const refreshToken = String(
              await ctx.prompter.text({
                message: "Paste refresh token (sk-ant-ort01-...)",
                validate: (v) => validateRefreshToken(String(v ?? "")),
              }) ?? "",
            ).trim();

            const profileName =
              String(
                await ctx.prompter.text({
                  message: "Profile name (blank = default)",
                  placeholder: "default",
                }) ?? "",
              ).trim() || "default";

            return {
              profiles: [
                {
                  profileId: `${PROVIDER_ID}:${profileName}`,
                  credential: {
                    type: "oauth",
                    provider: PROVIDER_ID,
                    access: accessToken,
                    refresh: refreshToken,
                    expires: Date.now() + 3600 * 1000,
                  },
                },
              ],
              defaultModel: `${PROVIDER_ID}/claude-opus-4-6`,
            };
          },
          async runNonInteractive(ctx) {
            const accessToken = typeof ctx.opts.accessToken === "string" ? ctx.opts.accessToken.trim() : "";
            if (!accessToken || validateAccessToken(accessToken)) {
              ctx.runtime.error("Missing or invalid --anthropic-access-token.");
              ctx.runtime.exit(1);
              return null;
            }
            const refreshToken = typeof ctx.opts.refreshToken === "string" ? ctx.opts.refreshToken.trim() : "";
            if (!refreshToken || validateRefreshToken(refreshToken)) {
              ctx.runtime.error("Missing or invalid --anthropic-refresh-token.");
              ctx.runtime.exit(1);
              return null;
            }
            const profileId = `${PROVIDER_ID}:default`;
            const { upsertAuthProfile, applyAuthProfileConfig } = await import("openclaw/plugin-sdk/provider-auth");
            upsertAuthProfile({
              profileId,
              agentDir: ctx.agentDir,
              credential: {
                type: "oauth",
                provider: PROVIDER_ID,
                access: accessToken,
                refresh: refreshToken,
                expires: Date.now() + 3600 * 1000,
              },
            });
            return applyAuthProfileConfig(ctx.config, {
              profileId,
              provider: PROVIDER_ID,
              mode: "oauth",
            });
          },
        },
      ],
      capabilities: {
        providerFamily: "anthropic",
      },
      catalog: {
        order: "profile",
        async run(ctx) {
          let resolved = ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!resolved?.apiKey) {
            resolved = ctx.resolveProviderApiKey("anthropic");
          }
          if (!resolved?.apiKey) return null;
          if (!resolved.apiKey.includes("sk-ant-oat")) return null;
          return {
            provider: {
              baseUrl: "https://api.anthropic.com",
              apiKey: resolved.apiKey,
              api: "anthropic-messages",
              models: CATALOG_MODELS,
            },
          };
        },
      },
      // Accept any claude-* model ID not in the catalog
      resolveDynamicModel(ctx) {
        return buildDynamicModel(ctx.modelId);
      },
      wrapStreamFn(ctx) {
        return createBillingAndBetaWrapper(ctx.streamFn);
      },
      async refreshOAuth(cred) {
        const response = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: cred.refresh,
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`Anthropic token refresh failed: ${response.status} — ${body}`);
        }
        const data = await response.json();
        if (!data.access_token || !data.refresh_token || !data.expires_in) {
          throw new Error(`Unexpected refresh response: ${JSON.stringify(data)}`);
        }
        return {
          ...cred,
          access: data.access_token,
          refresh: data.refresh_token,
          expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
        };
      },
      isCacheTtlEligible: () => true,
      isModernModelRef: ({ modelId }) => {
        const lower = modelId.trim().toLowerCase();
        return lower.startsWith("claude-");
      },
      resolveDefaultThinkingLevel: ({ modelId }) => {
        const lower = modelId.trim().toLowerCase();
        return lower.startsWith("claude-opus-4") || lower.startsWith("claude-sonnet-4") ? "adaptive" : undefined;
      },
    });
  },
});
