#!/usr/bin/env node
// CLI backing the /armor:* slash commands.
// Invoked by the Gemini command TOMLs via !{node scripts/armor/cli.mjs <sub> {{args}}}.
// Prints human-readable output to stdout, which Gemini pipes into the model
// prompt for the assistant to summarise back to the user.

import { loadConfig } from "../lib/config.mjs";
import {
  fetchPolicy,
  proposePolicyChange,
  proposePolicyTemplate
} from "../lib/backend-client.mjs";

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

async function cmdList() {
  const config = requireConfigured();
  const res = await fetchPolicy(config);
  if (!res.ok) {
    console.log(`Could not fetch policy from ArmorIQ (HTTP ${res.status}). ${res.error || ""}`.trim());
    return;
  }
  const rules = (res.policy && res.policy.rules) || [];
  if (rules.length === 0) {
    console.log("No policy rules found. Use /armor:add to create one, or /armor:template to apply a starter template.");
    return;
  }
  console.log("Current ArmorIQ policy:");
  for (const r of rules) {
    const note = r.note ? ` - ${r.note}` : "";
    console.log(`  [${r.id || "?"}] ${r.verb || "?"} ${r.target || "?"}${note}`);
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
  const res = await proposePolicyChange(config, { verb, target, note, reason: "Proposed via /armor:add" });
  if (!res.ok) {
    console.log(`Could not stage rule (${res.stage || "?"}, HTTP ${res.status || "?"}). ${res.error || ""}`.trim());
    return;
  }
  console.log(
    `Rule staged for confirmation on the ArmorIQ dashboard:\n  ${verb} ${target}${note ? ` - ${note}` : ""}\n` +
      "A human must confirm the proposal in the dashboard before it takes effect."
  );
}

async function cmdTemplate(args) {
  const config = requireConfigured();
  const template = (args[0] || "").trim();
  if (!template) {
    console.log(
      "Usage: /armor:template <name>\n" +
        "  Common templates: lockdown, strict-read-only, balanced, velocity-machine, architect, night-owl."
    );
    return;
  }
  const res = await proposePolicyTemplate(config, template);
  if (!res.ok) {
    console.log(`Could not stage template "${template}" (HTTP ${res.status || "?"}). ${res.error || ""}`.trim());
    return;
  }
  console.log(
    `Template "${template}" staged for confirmation on the ArmorIQ dashboard.\n` +
      "A human must confirm the proposal in the dashboard before it takes effect."
  );
}

function cmdHelp() {
  console.log(
    "ArmorGemini /armor commands\n" +
      "\n" +
      "  /armor:list                     Show the current ArmorIQ policy.\n" +
      "  /armor:add <verb> <target> ...  Stage a rule (verb: allow | deny | hold).\n" +
      "  /armor:template <name>          Stage a named policy template.\n" +
      "  /armor:help                     Show this help.\n" +
      "\n" +
      "ArmorGemini is backend-authoritative. All /armor commands stage proposals\n" +
      "on the ArmorIQ dashboard; a human confirms them there before they take\n" +
      "effect on this workspace's policy."
  );
}

const cmd = (sub || "help").toLowerCase();
try {
  if (cmd === "list") await cmdList();
  else if (cmd === "add") await cmdAdd(rest);
  else if (cmd === "template") await cmdTemplate(rest);
  else if (cmd === "help") cmdHelp();
  else {
    console.log(`Unknown /armor subcommand: "${cmd}". Run /armor:help for the list.`);
  }
} catch (err) {
  console.log(`ArmorGemini CLI error: ${err?.message || err}`);
  process.exit(0);
}
