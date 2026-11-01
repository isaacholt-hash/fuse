// M10 step 17 (CH-19): what a handoff between a chat and a session starts with. It goes into the
// new thread's composer, so you read and change it before anything is sent.

/** A turn, as the brief quotes it. */
export interface HandoffTurn {
  role: "user" | "assistant";
  content: string;
}

const EDIT_VERBS =
  /\b(fix|change|add|edit|refactor|rename|delete|remove|implement|update|write|create|move)\b/i;

/** Whether a chat message reads like a change to files (the Continue in Code hint). */
export function asksForAChange(text: string): boolean {
  return EDIT_VERBS.test(text);
}

const quote = (text: string, max = 600) => {
  const t = text.trim();
  const cut = t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
  return cut
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
};

/** Continue in Code: the chat's last three turns, quoted, and room for the task. */
export function codeBrief(title: string, turns: readonly HandoffTurn[]): string {
  const last = turns.filter((t) => t.content.trim()).slice(-6);
  const body = last
    .map((t) => `${t.role === "user" ? "Me" : "Answer"}:\n${quote(t.content)}`)
    .join("\n\n");
  return `Continuing from the chat "${title}":\n\n${body}\n\nThe task: `;
}

/** Discuss in Chat: what the session did, and the files its runs changed. */
export function chatBrief(
  title: string,
  answer: string | null,
  changed: readonly string[],
): string {
  const files =
    changed.length > 0 ? `\n\nFiles it changed:\n${changed.map((c) => `- ${c}`).join("\n")}` : "";
  const said = answer?.trim() ? `\n\nWhere it got to:\n${quote(answer)}` : "";
  return `About the session "${title}":${said}${files}\n\nMy question: `;
}
