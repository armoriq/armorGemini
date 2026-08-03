// stdin / stdout / stderr helpers for Gemini CLI hook contract.
// - stdin: JSON payload from Gemini
// - stdout: exactly one JSON object (the decision)
// - stderr: free-form diagnostics

export async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`invalid JSON on stdin: ${err.message}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

export function writeDecision(decision) {
  const payload = decision && typeof decision === "object" ? decision : { decision: "allow" };
  process.stdout.write(JSON.stringify(payload));
}

export function writeError(message) {
  process.stderr.write(`[armorgemini] ${message}\n`);
}

export function writeLog(message) {
  process.stderr.write(`[armorgemini] ${message}\n`);
}
