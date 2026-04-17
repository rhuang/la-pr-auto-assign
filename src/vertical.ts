import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { VERTICALS, type PRContext, type Vertical } from './types';

const MODEL_ID = 'claude-haiku-4-5-20251001';
const BODY_TRUNCATE_BYTES = 2048;

export const VERTICAL_SYSTEM_PROMPT = `You classify pull requests into one of three verticals based on which user-facing product surface they primarily affect:
- Professional: features for the legal professional / attorney user (case management, client queues, questionnaires from the pro side)
- Client: features for the end-client / litigant user (self-service intake, document review, status checks)
- Designer: form-builder / questionnaire authoring tools used by content designers

Respond with a JSON object on a single line: {"vertical":"Professional"} — use exactly one of Professional, Client, Designer, or None if you cannot confidently pick one. No other output.`;

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max);
}

/**
 * Build the user message sent to the classifier. Exported so tests can
 * assert on the prompt shape without calling the SDK.
 */
export function buildUserMessage(prContext: PRContext): string {
  const parts: string[] = [];
  parts.push(`Title: ${prContext.title}`);
  parts.push(`Body: ${truncate(prContext.body ?? '', BODY_TRUNCATE_BYTES)}`);

  if (prContext.linkedIssue) {
    const { ref, title, body } = prContext.linkedIssue;
    parts.push(
      `Linked issue (${ref.owner}/${ref.repo}#${ref.number}): ${title}\n${truncate(body ?? '', BODY_TRUNCATE_BYTES)}`,
    );
  }

  parts.push(`Diff:\n${prContext.diff ?? ''}`);
  return parts.join('\n\n');
}

const VALID_VERTICALS: ReadonlySet<string> = new Set<string>([...VERTICALS, 'None']);

/**
 * Classify the PR into one vertical (Professional | Client | Designer) or return null.
 *
 * Uses a single Anthropic Claude Haiku call. Input: PR title, body, linked-issue (if any),
 * and a truncated diff. Output: the vertical name or null if the model returns "None" OR
 * the call/parse fails for any reason (the action must never hard-fail on LLM issues — it
 * degrades to the `on_no_vertical` fallback path).
 *
 * Model id: "claude-haiku-4-5-20251001".
 * The function must be idempotent for a given prContext.headSha (pure w.r.t. inputs).
 */
export async function classifyVertical(
  apiKey: string,
  prContext: PRContext,
): Promise<Vertical | null> {
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 50,
      system: VERTICAL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(prContext) }],
    });

    const block = response.content[0];
    if (!block || block.type !== 'text') {
      core.warning(
        `classifyVertical: unexpected response shape (no text block) for PR #${prContext.number}`,
      );
      return null;
    }

    const text = block.text.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      core.warning(
        `classifyVertical: failed to parse JSON response for PR #${prContext.number}: ${text}`,
      );
      return null;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { vertical?: unknown }).vertical !== 'string'
    ) {
      core.warning(
        `classifyVertical: response missing 'vertical' string for PR #${prContext.number}: ${text}`,
      );
      return null;
    }

    const vertical = (parsed as { vertical: string }).vertical;
    if (!VALID_VERTICALS.has(vertical)) {
      core.warning(
        `classifyVertical: invalid vertical value for PR #${prContext.number}: ${vertical}`,
      );
      return null;
    }

    if (vertical === 'None') {
      return null;
    }

    return vertical as Vertical;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`classifyVertical: Anthropic call failed for PR #${prContext.number}: ${message}`);
    return null;
  }
}
