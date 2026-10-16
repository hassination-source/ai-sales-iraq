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
        tool_choice: { type: "tool", name: DRAFT_TOOL.name },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true };
  }
  const body = (await res.json().catch(() => null)) as null | {
    content?: { type: string; name?: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (!res.ok || !body) {
    const error = body?.error?.message ?? `HTTP ${res.status}`;
    // key, permission, workspace or model problems: a setup issue, not a bad prospect
    const config = res.status === 401 || res.status === 403 || res.status === 404 || (res.status === 400 && /workspace|api key|model/i.test(error));
    return { ok: false, error, retryable: res.status === 429 || res.status >= 500, config };
  }
  const input = body.usage?.input_tokens ?? 0;
  const output = body.usage?.output_tokens ?? 0;
  const usage = { input, output, costUsd: estimateCostUsd(input, output, { input: cfg.priceIn, output: cfg.priceOut }) };
  const call = body.content?.find((c) => c.type === "tool_use" && c.name === DRAFT_TOOL.name);
  if (!call) return { ok: false, error: "model did not return a draft", retryable: false, usage };
  const checked = checkDraft(call.input, sourceIds);
  if (!checked.ok) return { ok: false, error: checked.reason, retryable: false, usage };
  return { ok: true, draft: checked.draft, sourceIds, usage };
}
