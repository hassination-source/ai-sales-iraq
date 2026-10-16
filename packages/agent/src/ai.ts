import { buildDraftPrompt, checkDraft, DRAFT_TOOL, estimateCostUsd, type DraftOutput, type DraftRequest } from "@ais/core";
import type { Fetch } from "./http";

export interface AiConfig {
  apiKey: string;
  /** required by Anthropic for keys that aren't scoped to a workspace */
  workspaceId?: string;
  model: string;
  priceIn: number;
  priceOut: number;
}

export type AiResult =
  | { ok: true; draft: DraftOutput; sourceIds: string[]; usage: { input: number; output: number; costUsd: number } }
  | { ok: false; error: string; retryable: boolean; config?: boolean; usage?: { input: number; output: number; costUsd: number } };

/** Ask the model for one grounded draft via forced tool use; validate before returning. */
export async function writeDraft(req: DraftRequest, cfg: AiConfig, f: Fetch = fetch): Promise<AiResult> {
  const { system, user, sourceIds } = buildDraftPrompt(req);
  let res: Response;
  try {
    res = await f("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        ...(cfg.workspaceId ? { "anthropic-workspace-id": cfg.workspaceId } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: user }],
        tools: [DRAFT_TOOL],
        // newer models don't accept a forced tool; the prompt requires it and the output is validated either way
        tool_choice: { type: "auto" },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, error: msg, retryable: true };
  }
  const body = (await res.json().catch(() => null)) as null | {
    content?: { type: string; name?: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (!res.ok || !body) {
    const error = `HTTP ${res.status}: ${body?.error?.message ?? "no message"}`;
    // key, permission, workspace or model problems: a setup issue, not a bad prospect
    const config = res.status === 401 || res.status === 403 || res.status === 404 || (res.status === 400 && /workspace|api key|model/i.test(error));
    return { ok: false, error, retryable: res.status === 429 || res.status >= 500, config };
  }
  const input = body.usage?.input_tokens ?? 0;
  const output = body.usage?.output_tokens ?? 0;
  const usage = { input, output, costUsd: estimateCostUsd(input, output, { input: cfg.priceIn, output: cfg.priceOut }) };
  const call = body.content?.find((c) => c.type === "tool_use" && c.name === DRAFT_TOOL.name);
  // fallback: a JSON object answered as plain text
  const text = body.content?.find((c) => c.type === "text") as { text?: string } | undefined;
  const json = call?.input ?? parseJsonObject(text?.text);
  if (!json) return { ok: false, error: "model did not return a draft", retryable: false, usage };
  const checked = checkDraft(json, sourceIds);
  if (!checked.ok) return { ok: false, error: checked.reason, retryable: false, usage };
  return { ok: true, draft: checked.draft, sourceIds, usage };
}

function parseJsonObject(text: string | undefined): unknown {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
