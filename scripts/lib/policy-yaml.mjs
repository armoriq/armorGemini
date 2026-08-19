// Hand-rolled YAML formatter for the armor.policy.v1 PolicyProfile shape.
// Small, dependency-free, purpose-built for the fields the plugin actually
// writes (metadata, defaults, statements with principal/action/resource/
// conditions). Not a general YAML dumper.
//
// The output is meant to be READ by a human in the terminal to decide
// whether to /armor:yes or /armor:no. It is not meant to be parsed back
// into a policy — the source of truth is the JSON stored in the pending
// file, and the same JSON is what the plugin actually sends to the backend.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function quoteScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const s = String(value);
  // Quote when the value contains any character that would change YAML
  // meaning if left bare. Also quote empty strings.
  if (s === "" || /[:#\-{}\[\],&*!|>'"%@`\n]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function dumpValue(value, indent) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return " []";
    const items = value.map((item) => {
      if (isPlainObject(item)) {
        const inner = dumpObject(item, indent + 2);
        // First key sits next to the "- ", subsequent keys are re-indented.
        return `\n${pad}- ${inner.replace(/^ +/, "")}`;
      }
      return `\n${pad}- ${quoteScalar(item)}`;
    });
    return items.join("");
  }
  if (isPlainObject(value)) {
    return "\n" + dumpObject(value, indent + 2);
  }
  return " " + quoteScalar(value);
}

function dumpObject(obj, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      lines.push(`${pad}${key}:${dumpValue(value, indent + 2)}`);
    } else if (isPlainObject(value)) {
      lines.push(`${pad}${key}:${dumpValue(value, indent + 2)}`);
    } else {
      lines.push(`${pad}${key}:${dumpValue(value, indent)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render a PolicyProfile as human-readable YAML for the terminal preview.
 * Layout mirrors the shape the backend accepts so the reader can eyeball
 * exactly what will be sent when they run /armor:yes.
 */
export function policyToYaml(policy) {
  if (!isPlainObject(policy)) return "(no policy)";
  return dumpObject(policy, 0);
}
