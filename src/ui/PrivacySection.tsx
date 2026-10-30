import { ShieldCheck } from "lucide-react";

export interface GlobalProviderRule {
  id: "anthropic" | "openai";
  name: string;
  allowed: boolean;
}

const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-xs";

/**
 * Settings → Privacy (SE-15, SE-13): what stays on this computer, what a cloud answer sends, and
 * which providers may receive anything at all. Projects can narrow this further.
 */
export function PrivacySection({
  providers,
  onProvider,
}: {
  providers: GlobalProviderRule[];
  onProvider: (provider: GlobalProviderRule["id"], allow: boolean) => void;
}) {
  return (
    <section className="mt-8 border-t pt-6" aria-label="Privacy">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Privacy</h2>
      </div>
      <div className="space-y-2 text-[11px] leading-5 text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Stored on this computer.</span> Your chats,
          memories, decisions, tasks, projects and files live in an encrypted database here, and
          your API keys in the OS keychain. Nothing is synced anywhere.
        </p>
        <p>
          <span className="font-medium text-foreground">
            Stored locally doesn&apos;t mean answered locally.
          </span>{" "}
          Every answer comes from a cloud model at OpenAI or Anthropic, or from a fixed rule on this
          computer for sums, conversions and checks. The local model, once installed, does only
          housekeeping, and nothing it sees leaves this computer.
        </p>
        <p>
          <span className="font-medium text-foreground">What a cloud answer sends</span> to the
          provider that answers: your message and the chat so far (or its summary), your
          instructions, the memories, decisions and tasks that apply to the chat, and the matching
          parts of any files it searches. Titles, summaries and memory suggestions go to the local
          model when it&apos;s installed, and otherwise (or if it fails) to a cheap cloud model the
          same way. Searching by meaning sends text to OpenAI to be embedded. Each provider handles
          what it receives under its own terms.
        </p>
        <p>
          <span className="font-medium text-foreground">When a model reads your documents</span>{" "}
          (Code and Work in a folder), what it reads goes to the provider running the task: the text
          of each file it opens, a Word, Excel or PDF file&apos;s text, pictures it looks at, and
          what commands print. It can only open files inside the folders you added. Files it
          doesn&apos;t open stay here. A project&apos;s folder documents are its knowledge, so only
          the parts that match a question are sent. Commands run on this computer, sandboxed where
          the system allows, with no network unless you allow it.
        </p>
        <p>
          <span className="font-medium text-foreground">What never leaves:</span> memories and
          knowledge files you mark to keep on this computer, anything in a project set to Local
          only, and anything for a provider blocked below or in a project. FUSE checks this twice,
          in the app and again just before a request goes out, and says so when it refuses to send a
          message.
        </p>
      </div>
      <div className="mt-3 space-y-1 text-xs" role="group" aria-label="Providers everywhere">
        {providers.map((p) => (
          <label key={p.id} className="flex items-center gap-2">
            <span className="w-20">{p.name}</span>
            <select
              aria-label={`${p.name} everywhere`}
              className={selectClass}
              value={p.allowed ? "allow" : "block"}
              onChange={(e) => {
                onProvider(p.id, e.target.value === "allow");
              }}
            >
              <option value="allow">Allowed</option>
              <option value="block">Blocked</option>
            </select>
          </label>
        ))}
        <p className="text-[10px] text-muted-foreground">
          A project can allow or block a provider for itself, or be set to Local only, in its
          settings.
        </p>
      </div>
    </section>
  );
}
