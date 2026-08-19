#!/usr/bin/env node
// CLI backing the /armor:* slash commands.
// Invoked by the Gemini command TOMLs via !{node scripts/armor/cli.mjs <sub> {{args}}}.
// Prints human-readable output to stdout, which Gemini pipes into the model
// prompt for the assistant to summarise back to the user.
//
// v0.3.1: /armor:add and /armor:template STAGE the change locally with a
// YAML preview. /armor:yes confirms and pushes to the ArmorIQ backend;
// /armor:no discards. Matches ArmorClaude's stage-then-yes UX so nothing
// hits the backend without the user seeing what's about to be sent.

import { loadConfig } from "../lib/config.mjs";
import {
  buildPolicyForRule,
  buildPolicyForTemplate,
  listTemplateNames,
  pushProposal
} from "../lib/backend-client.mjs";
import { stagePending, readPending, clearPending } from "../lib/pending.mjs";
import { policyToYaml } from "../lib/policy-yaml.mjs";
import { saveActivePolicy, readActivePolicy } from "../lib/local-policy.mjs";

const [, , sub, ...rest] = process.argv;

function requireConfigured() {
  const config = loadConfig();
  if (!config.isConfigured) {
    console.log(
      "ArmorGemini is not connected to an ArmorIQ account yet.\n" +
        "\n" +
        "Run this in a terminal to authenticate:\n" +
        "  armoriq login --product armorgemini\n" +
        "\n" +
        "It opens the browser, mints a key, and writes ~/.armoriq/credentials.json.\n" +
        "Then re-run the /armor command.\n" +
        "\n" +
        "If you have not installed the plugin yet:\n" +
        "  curl -fsSL https://armoriq.ai/install_armorgemini.sh | bash"
    );
    process.exit(0);
  }
  return config;
}

function printStagedPreview(record) {
  const yaml = policyToYaml(record.policy);
  console.log(`Staged proposal ${record.proposalId} (expires ${record.expiresAt}):`);
  console.log("");
  console.log(yaml);
  console.log("");
  console.log("Review the policy above. Then:");
  console.log("  /armor:yes    apply this proposal to the ArmorIQ backend");
  console.log("  /armor:no     discard it");
  console.log("");
  console.log("ArmorGemini keeps the change local until you say /armor:yes.");
}

async function cmdList() {
  const config = requireConfigured();
  const policy = readActivePolicy(config.dataDir);
  if (!policy) {
    console.log("No active local policy. Every tool falls to the default (allow) until /armor:add + /armor:yes.");
    return;
  }
  const statements = Array.isArray(policy.statements) ? policy.statements : [];
  console.log(
    `Active local policy: ${policy.metadata?.name || "unnamed"} ` +
      `(default: ${policy.defaults?.decision || "allow"})`
  );
  if (statements.length === 0) {
    console.log("  (no explicit rules — every tool falls to the default decision)");
    return;
  }
  for (const s of statements) {
    console.log(
      `  [${s.id}] ${s.effect} ${s.action?.eq || "*"}` +
        (s.description ? ` - ${s.description}` : "")
    );
  }
}

async function cmdAdd(args) {
  const config = requireConfigured();
  const trimmed = args.join(" ").trim();
  if (!trimmed) {
    console.log(
      "Usage: /armor:add <verb> <target> [note...]\n" +
        "  verb   allow | deny | hold\n" +
        "  target tool name (e.g. run_shell_command, write_file, web_fetch)\n" +
        "  note   optional human explanation stored with the rule\n" +
        "\n" +
        "Example: /armor:add deny web_fetch external network is not allowed on this workspace"
    );
    return;
  }
  const parts = trimmed.split(/\s+/);
  const verb = parts.shift();
  const target = parts.shift();
  const note = parts.join(" ");
  if (!["allow", "deny", "hold"].includes(verb)) {
    console.log(`Unknown verb "${verb}". Use allow, deny, or hold.`);
    return;
  }
  if (!target) {
    console.log("Missing target tool name.");
    return;
  }
  const policy = buildPolicyForRule({ verb, target, note });
  const record = stagePending(config.dataDir, {
    policy,
    reason: `Staged via /armor:add ${verb} ${target}${note ? ` (${note})` : ""}`,
    source: "cli:add"
  });
  printStagedPreview(record);
}

async function cmdTemplate(args) {
  const config = requireConfigured();
  const template = (args[0] || "").trim();
  if (!template) {
    console.log(
      "Usage: /armor:template <name>\n" +
        `  Available: ${listTemplateNames().join(", ")}.`
    );
    return;
  }
  const policy = buildPolicyForTemplate(template);
  if (!policy) {
    console.log(
      `Unknown template "${template}". Available: ${listTemplateNames().join(", ")}.`
    );
    return;
  }
  const record = stagePending(config.dataDir, {
    policy,
    reason: `Staged via /armor:template ${template}`,
    source: "cli:template"
  });
  printStagedPreview(record);
}

async function cmdYes() {
  const config = requireConfigured();
  const { record, expired } = readPending(config.dataDir);
  if (!record) {
    console.log("Nothing staged. Use /armor:add or /armor:template first.");
    return;
  }
  if (expired) {
    clearPending(config.dataDir);
    console.log("The staged proposal expired. Stage it again with /armor:add or /armor:template.");
    return;
  }

  // Local activation is authoritative for enforcement (matches ArmorClaude).
  // Write the policy to $dataDir/policy.json BEFORE the network hop so a
  // failing backend push does not block enforcement.
  saveActivePolicy(config.dataDir, record.policy);

  // Backend push is fire-and-forget: audit + fleet propagation only. If it
  // fails, enforcement on this box is already live from the local file, so
  // we report the failure but do not roll back the local activation.
  const res = await pushProposal(config, record.policy, record.reason);

  clearPending(config.dataDir);

  if (!res.ok) {
    console.log(
      `Local policy activated (proposal ${record.proposalId}).\n` +
        `BeforeTool now enforces it on this Gemini CLI session immediately.\n` +
        "\n" +
        `Backend audit push failed (${res.stage || "?"}, HTTP ${res.status || "?"}): ${res.error || ""}\n`.trim() +
        "\n" +
        "The local enforcement is unaffected. Re-run /armor:yes to retry the audit push later, or leave it — the next successful /armor:yes will re-sync the backend."
    );
    return;
  }

  console.log(
    `Local policy activated (proposal ${record.proposalId}).\n` +
      "BeforeTool now enforces it on this Gemini CLI session immediately - no dashboard step required.\n" +
      "The same policy was also pushed to the ArmorIQ backend for audit and fleet propagation."
  );
}

async function cmdNo() {
  const config = requireConfigured();
  const { record } = readPending(config.dataDir);
  if (!record) {
    console.log("Nothing staged to discard.");
    return;
  }
  clearPending(config.dataDir);
  console.log(`Discarded staged proposal ${record.proposalId}. No changes sent to ArmorIQ.`);
}

function cmdHelp() {
  console.log(
    "ArmorGemini /armor commands\n" +
      "\n" +
      "  /armor:list                     Show the current ArmorIQ policy.\n" +
      "  /armor:add <verb> <target> ...  Stage a rule (verb: allow | deny | hold).\n" +
      "  /armor:template <name>          Stage a named policy template.\n" +
      "  /armor:yes                      Apply the currently staged proposal.\n" +
      "  /armor:no                       Discard the currently staged proposal.\n" +
      "  /armor:help                     Show this help.\n" +
      "\n" +
      "Flow: /armor:add or /armor:template previews the exact policy that will\n" +
      "be sent to ArmorIQ as YAML. Nothing hits the backend until you run\n" +
      "/armor:yes. Staged proposals expire after 30 minutes.\n" +
      "\n" +
      "After /armor:yes, the proposal lands on the ArmorIQ dashboard for the\n" +
      "workspace owner's final confirmation before it becomes active."
  );
}

const cmd = (sub || "help").toLowerCase();
try {
  if (cmd === "list") await cmdList();
  else if (cmd === "add") await cmdAdd(rest);
  else if (cmd === "template") await cmdTemplate(rest);
  else if (cmd === "yes" || cmd === "confirm") await cmdYes();
  else if (cmd === "no" || cmd === "cancel") await cmdNo();
  else if (cmd === "help") cmdHelp();
  else {
    console.log(`Unknown /armor subcommand: "${cmd}". Run /armor:help for the list.`);
  }
} catch (err) {
  console.log(`ArmorGemini CLI error: ${err?.message || err}`);
  process.exit(0);
}
