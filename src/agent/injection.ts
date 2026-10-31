// Flags what a tool result asks for (M9 step 4, AG-10 part 2). A fixed rule set looks for text
// that reads like an instruction to an agent: ignore your rules, run this, delete that, send it
// there, show the secrets. A flag never blocks anything by itself and never depends on the model:
// once a run has one, every later write, command or send asks you, shows the passage, and can't be
// always-allowed. False alarms cost a click; a missed one would cost more.
import type { StepFlag } from "@/storage/runs";
import { kindOf } from "./registry";

interface Rule {
  why: string;
  re: RegExp;
}

const RULES: Rule[] = [
  {
    why: "says to ignore your instructions",
    re: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the|these|system)\b[^.\n]{0,25}\b(?:instructions?|rules|prompts?|guidelines|directions)\b/i,
  },
  {
    why: "claims to speak as the system or the user",
    re: /^\s*(?:system|assistant|developer|admin(?:istrator)?)\s*(?:message|prompt|note)?\s*:|\byou are now\b|\b(?:new|updated|real) instructions\b|\bthe user (?:wants|asked|has asked) you to\b/im,
  },
  {
    why: "asks to run a command",
    re: /\b(?:run|execute|exec)\b[^.\n]{0,30}\b(?:command|script|shell|terminal|following|this)\b|\b(?:curl|wget|iwr|irm|invoke-(?:webrequest|restmethod))\b[^\n|]{0,200}\|\s*(?:sh|bash|zsh|powershell|pwsh|iex|python3?)\b|\bpowershell(?:\.exe)?\b[^\n]{0,30}\s-e(?:nc(?:odedcommand)?)?\s/i,
  },
  {
    why: "asks to delete files",
    re: /\brm\s+-[a-z]*(?:rf|fr)\b|\b(?:rmdir|rd|del)\s+\/[sq]\b|\b(?:delete|remove|wipe|erase|destroy)\b[^.\n]{0,30}\b(?:all|every|entire|whole)\b[^.\n]{0,30}\b(?:files?|folders?|director(?:y|ies)|repo(?:sitory)?|data|code)\b/i,
  },
  {
    why: "asks to send something somewhere",
    re: /\b(?:send|e-?mail|post|upload|forward|exfiltrate|transmit|submit)\b[^.\n]{0,60}(?:\b[\w.+-]+@[\w-]+\.[a-z][\w.]*|\bhttps?:\/\/)/i,
  },
  {
    why: "asks for secrets",
    re: /\b(?:send|print|show|reveal|output|share|copy|paste|leak|read|cat|dump)\b[^.\n]{0,40}(?:\bapi[ _-]?keys?\b|\bpasswords?\b|\bsecrets?\b|\baccess tokens?\b|\bcredentials\b|\bprivate keys?\b|\.env\b|\bssh keys?\b|\bid_rsa\b)/i,
  },
];

/** The most flags kept for one result: enough to show what it asked, not a list of every line. */
export const MAX_FLAGS = 3;
const PASSAGE = 200;

/** The line around a match, cut to about 200 characters with the match in it. */
function passageAt(text: string, index: number, length: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const endAt = text.indexOf("\n", index + length);
  const line = text.slice(start, endAt === -1 ? text.length : endAt).trim();
  if (line.length <= PASSAGE) return line;
  const at = Math.max(0, index - start - 60);
  const cut = line.slice(at, at + PASSAGE).trim();
  return `${at > 0 ? "…" : ""}${cut}${at + PASSAGE < line.length ? "…" : ""}`;
}

/** Instruction-like passages in a tool's output, one per rule, at most three. */
export function findInstructions(text: string): StepFlag[] {
  const out: StepFlag[] = [];
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    out.push({ why: rule.why, passage: passageAt(text, m.index, m[0].length) });
    if (out.length === MAX_FLAGS) break;
  }
  return out;
}

/**
 * Whether a tool's output is checked: what reads and commands brought in from outside FUSE (and
 * any tool FUSE doesn't know, such as an MCP one later). Writes only report what FUSE did.
 */
export function scansOutput(tool: string): boolean {
  const kind = kindOf(tool);
  return kind === undefined || kind === "read" || kind === "command";
}
