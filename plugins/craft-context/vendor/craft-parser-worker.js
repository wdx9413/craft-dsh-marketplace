// common/craft-common-store-local/src/store.ts
import { DatabaseSync } from "node:sqlite";

// common/craft-common-base/src/scope-policy.ts
var COGNITIVE_SCOPE_KINDS = ["user", "project", "workspace", "task", "session", "team", "organization", "global"];

// common/craft-common-base/src/validation.ts
var SCOPE_KINDS = new Set(COGNITIVE_SCOPE_KINDS);

// core/untrusted-parser.ts
var MAX_CONTENT_BYTES = 1024 * 1024;
function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}
function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
function jsonPointer(root, pointer) {
  if (!pointer.startsWith("/")) throw new Error("JSON selectors must be RFC 6901 pointers beginning with /");
  let value = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (["__proto__", "prototype", "constructor"].includes(segment)) throw new Error("Unsafe JSON selector segment");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) throw new Error(`JSON selector not found: ${pointer}`);
    value = value[segment];
  }
  return value;
}
function textLine(raw, selector) {
  const match = /^line:([1-9][0-9]*)$/u.exec(selector);
  if (!match) throw new Error("Text selectors must use line:N with a one-based line number");
  const line = raw.split(/\r?\n/u)[Number(match[1]) - 1];
  if (line === void 0) throw new Error(`Text selector not found: ${selector}`);
  return line.trim();
}
var SIGNAL_RULES = [
  ["instruction_override", /(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|prompts?)/iu],
  ["prompt_boundary_impersonation", /(?:system|developer)\s+(?:prompt|message|instruction)/iu],
  ["secret_exfiltration_request", /(?:reveal|send|print|exfiltrate)\s+(?:the\s+)?(?:secret|token|password|api[_ -]?key)/iu],
  ["tool_execution_request", /(?:call|execute|run)\s+(?:the\s+)?(?:tool|command|shell)/iu],
  ["instruction_override_zh", /忽略.{0,12}(?:之前|以上|原有).{0,8}指令/u],
  ["secret_exfiltration_request_zh", /(?:泄露|发送|输出).{0,12}(?:密钥|密码|令牌)/u]
];
function instructionSignals(raw) {
  return SIGNAL_RULES.filter(([, rule]) => rule.test(raw)).map(([name]) => name);
}
function extractFields(raw, format2, selectors2) {
  let parsed = raw;
  if (format2 === "json") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("raw_content is not valid JSON");
    }
  }
  const structuredData = {};
  for (const [field, selectorValue] of Object.entries(selectors2)) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(field)) throw new Error("selector field names may contain only letters, numbers, _ or -");
    const selector = requiredText(selectorValue, `selectors.${field}`).trim();
    structuredData[field] = format2 === "json" ? jsonPointer(parsed, selector) : textLine(raw, selector);
  }
  return structuredData;
}
function analyzeUntrustedContent(raw, requestedFormat, requestedSelectors) {
  const parserFormat = format(requestedFormat);
  const parserSelectors = selectors(requestedSelectors);
  return {
    format: parserFormat,
    selectors: parserSelectors,
    structured_data: extractFields(raw, parserFormat, parserSelectors),
    detected_instructions: instructionSignals(raw)
  };
}
function format(value) {
  const result = requiredText(value, "format").trim();
  if (!(/* @__PURE__ */ new Set(["json", "text"])).has(result)) throw new Error("format must be json or text");
  return result;
}
function selectors(value) {
  const result = requiredObject(value, "selectors");
  if (!Object.keys(result).length) throw new Error("selectors must not be empty");
  return result;
}

// bin/craft-parser-worker.ts
var input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const request = JSON.parse(input);
    if (typeof request.raw_content !== "string") throw new Error("raw_content must be a string");
    process.stdout.write(JSON.stringify({
      ok: true,
      analysis: analyzeUntrustedContent(request.raw_content, request.format, request.selectors)
    }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Parser worker failed" }));
    process.exitCode = 1;
  }
});
