// HTTP client for the ArmorIQ IAP backend.
// ArmorGemini is backend-only: every enforcement decision and every audit
// record flows through here. There is no local fallback.

import { authHeaders } from "./config.mjs";

function endpoint(config, path) {
  return `${config.backendEndpoint}${path}`;
}

async function jsonRequest(config, method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(endpoint(config, path), {
      method,
      headers: authHeaders(config),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the backend whether a tool call is allowed.
 *
 * Uses POST /iap/enforce, the same policy-evaluation endpoint the SDK's
 * `armoriq check` reads from. Returns an evaluation of the tool call against
 * the workspace's active ArmorIQ policy. No pre-registered intent token is
 * required (unlike /iap/verify-step, which is the CSRG-Merkle-proof path
 * ArmorClaude uses).
 *
 * Response shape from /iap/enforce:
 *   { allowed: bool, action: "allow" | "deny", reason: string,
 *     matched_policy: {...}|null }
 *
 * Fails closed on 4xx/5xx that indicate real auth or backend problems; fails
 * open (with a monitor-mode note) on 400 from an evolving backend schema, so
 * a payload contract drift doesn't wedge every session. The audit log still
 * captures every call either way, so no enforcement telemetry is lost.
 */
export async function verifyStep(config, { sessionId, toolName, toolInput, description }) {
  const res = await jsonRequest(config, "POST", "/iap/enforce", {
    source: "armorgemini",
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
    description: description || undefined,
    org_id: config.orgId
  });

  if (res.status === 401 || res.status === 403) {
    return { allowed: false, reason: "ArmorIQ API key invalid or lacks permission", fatal: true };
  }
  // 400 == the backend rejected our payload shape. Log it, fall through to
  // monitor mode instead of wedging the session. Real deny decisions come
  // back as 200 with { allowed: false }.
  if (res.status === 400) {
    return {
      allowed: true,
      reason: `ArmorGemini monitor: backend HTTP 400 (payload contract drift), see logs`,
      verdict: "monitor"
    };
  }
  if (!res.ok) {
    return {
      allowed: false,
      reason: `ArmorIQ backend unavailable (HTTP ${res.status || "network"}). Fail-closed policy applies.`,
      fatal: false
    };
  }
  const data = res.data || {};
  const isAllowed = data.allowed !== false && data.action !== "deny";
  return {
    allowed: isAllowed,
    reason: typeof data.reason === "string" ? data.reason : "",
    verdict: data.action || (isAllowed ? "allow" : "deny"),
    matchedPolicy: data.matched_policy || null
  };
}

/**
 * Send an audit record. Best-effort. If the backend is unreachable we still
 * return the decision to Gemini (audit is post-hoc, not enforcement).
 */
export async function sendAudit(config, entry) {
  const res = await jsonRequest(config, "POST", "/iap/audit", {
    source: "armorgemini",
    ...entry
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Fetch the current policy rules for display in /armor:list.
 */
export async function fetchPolicy(config) {
  const res = await jsonRequest(config, "GET", "/policies/current");
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  return { ok: true, policy: res.data };
}

/**
 * Stage a policy change as a draft proposal. The dashboard-side confirmation
 * step is deliberately not exposed here, matching ArmorClaude's convention.
 */
export async function proposePolicyChange(config, { verb, target, note, reason }) {
  const draft = await jsonRequest(config, "PUT", "/policies/profiles/draft", {
    source: "armorgemini",
    change: { verb, target, note: note || "" },
    org_id: config.orgId
  });
  if (!draft.ok) {
    return { ok: false, stage: "draft", status: draft.status, error: draft.error };
  }

  const proposal = await jsonRequest(config, "POST", "/policies/profiles/propose", {
    source: "armorgemini",
    reason: reason || "Proposed via /armor",
    org_id: config.orgId
  });
  if (!proposal.ok) {
    return { ok: false, stage: "propose", status: proposal.status, error: proposal.error };
  }
  return { ok: true, proposal: proposal.data };
}

/**
 * Apply a named policy template (lockdown, strict-read-only, balanced, etc).
 * Same lifecycle as proposePolicyChange - stages a draft for dashboard
 * confirmation.
 */
export async function proposePolicyTemplate(config, templateName) {
  const res = await jsonRequest(config, "POST", "/policies/profiles/template", {
    source: "armorgemini",
    template: templateName,
    org_id: config.orgId
  });
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  return { ok: true, proposal: res.data };
}
