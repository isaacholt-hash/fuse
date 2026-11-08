import { useState } from "react";
import { BookOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readSkillPackage, skillName, SKILL_LIMITS, type SkillPackage } from "@/skills/package";
import type { SkillView } from "@/skills/storage";

export interface SkillImport {
  name: string;
  projectId: string | null;
  localOnly: boolean;
  package: SkillPackage;
  skillId?: string;
}

/** Import is an explicit, reviewed library change; choosing a package never sends a request. */
export function SkillsSection({
  skills,
  projects,
  onImport,
  onDelete,
}: {
  skills: SkillView[];
  projects: { id: string; name: string }[];
  onImport: (input: SkillImport) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState("");
  const [localOnly, setLocalOnly] = useState(false);
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState<SkillPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const where = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.name ?? "Unavailable project") : "Every chat";
  const report = (e: unknown) => {
    setProblem(e instanceof Error ? e.message : "The skill couldn't be saved.");
  };
  const field =
    "h-8 min-w-0 rounded-md border bg-background px-2 text-xs scheme-light dark:scheme-dark";
  return (
    <section aria-label="Skills" className="mt-8 border-t pt-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <BookOpen className="size-4 text-muted-foreground" />
        Skills
      </h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Reusable instruction packages and supporting files. Invoke with /skill name or select a
        pinned version in the command palette. Packages grant no permissions; importing never runs
        scripts or sends a message. Instructions go to the chosen model when you send an invocation;
        supporting files can be read for that request.
      </p>
      {problem && (
        <p role="alert" className="my-2 text-xs text-destructive">
          {problem}
        </p>
      )}
      {skills.length > 0 && (
        <ul aria-label="Imported skills" className="my-3 space-y-2">
          {skills.map((s) => (
            <li key={s.id} className="rounded-md border p-3 text-xs">
              <div className="flex items-center gap-2">
                <strong className="min-w-0 flex-1 break-words">/skill {s.name}</strong>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete skill ${s.name}`}
                  onClick={() => {
                    setDeleting(s.id);
                  }}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
              <p className="mt-1 text-muted-foreground">
                {where(s.projectId)} · {s.versions} version{s.versions === 1 ? "" : "s"}
                {s.localOnly ? " · Excluded from sync here" : ""}
              </p>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                Version {s.versionId} · SHA-256 {s.sha256}
              </p>
              {deleting === s.id && (
                <div className="mt-2 space-y-2">
                  <p>
                    Delete this package and all its versions? Enrolled sync propagates deletion.
                    Existing messages keep their invocation record; future use of these versions
                    will stop.
                  </p>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setProblem(null);
                      void onDelete(s.id)
                        .then(() => {
                          setDeleting(null);
                        })
                        .catch(report)
                        .finally(() => {
                          setBusy(false);
                        });
                    }}
                  >
                    Delete package
                  </Button>{" "}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDeleting(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        aria-label="Import skill"
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!preview) return;
          try {
            skillName(name);
          } catch (e) {
            report(e);
            return;
          }
          setBusy(true);
          setProblem(null);
          void onImport({
            name,
            projectId: scope || null,
            localOnly,
            package: preview,
            ...(target ? { skillId: target } : {}),
          })
            .then(() => {
              setPreview(null);
              setName("");
              setTarget("");
            })
            .catch(report)
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            Package
            <select
              aria-label="Skill package"
              value={target}
              className={`${field} w-full`}
              disabled={busy}
              onChange={(e) => {
                const s = skills.find((s) => s.id === e.target.value);
                setTarget(e.target.value);
                if (s) {
                  setName(s.name);
                  setScope(s.projectId ?? "");
                  setLocalOnly(s.localOnly);
                }
              }}
            >
              <option value="">New package</option>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  New version: {s.name} · {where(s.projectId)} · {s.versionId.slice(-8)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            Name
            <Input
              aria-label="Skill name"
              value={name}
              disabled={busy || Boolean(target)}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="e.g. release-notes"
              className="h-8 text-xs"
            />
          </label>
          <label className="space-y-1 text-xs">
            Available in
            <select
              aria-label="Skill scope"
              value={scope}
              disabled={busy || Boolean(target)}
              onChange={(e) => {
                setScope(e.target.value);
              }}
              className={`${field} w-full`}
            >
              <option value="">Every chat</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={localOnly}
              disabled={busy || Boolean(target)}
              onChange={(e) => {
                setLocalOnly(e.target.checked);
              }}
            />
            Exclude this package from sync
          </label>
        </div>
        <label className="block space-y-2 text-xs">
          SKILL.md or ZIP package
          <input
            type="file"
            aria-label="Choose skill package"
            accept=".md,.zip"
            disabled={busy}
            className="block max-w-full text-xs"
            onChange={(e) => {
              const file = e.target.files?.[0];
              setPreview(null);
              setProblem(null);
              if (!file) return;
              if (file.size > SKILL_LIMITS.archive) {
                setProblem("Skill imports are limited to 2 MiB.");
                return;
              }
              setBusy(true);
              void file
                .arrayBuffer()
                .then((b) => readSkillPackage(file.name, new Uint8Array(b)))
                .then(setPreview)
                .catch(report)
                .finally(() => {
                  setBusy(false);
                });
              e.target.value = "";
            }}
          />
        </label>
        <p className="text-[12px] leading-5 text-muted-foreground">
          At most 64 entries, 256 KiB per file, 2 MiB total; SKILL.md at most 32 KiB. Links, unsafe
          paths and private file names are refused. Portable packages follow opt-in sync; grants
          remain local.
        </p>
        {preview && (
          <div
            aria-label="Skill import preview"
            className="space-y-2 rounded-md border p-3 text-xs"
          >
            <p>
              {preview.source} · {preview.assets.length} file
              {preview.assets.length === 1 ? "" : "s"} ·{" "}
              {preview.assets.reduce((n, a) => n + a.bytes, 0).toLocaleString()} bytes
            </p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[12px]">
              {preview.instructions}
            </pre>
            <ul className="max-h-32 overflow-auto text-muted-foreground">
              {preview.assets.map((a) => (
                <li key={a.path} className="break-all">
                  {a.path} · {a.bytes.toLocaleString()} bytes
                </li>
              ))}
            </ul>
            <p className="break-all font-mono text-[11px]">SHA-256 {preview.sha256}</p>
            <Button type="submit" size="sm" disabled={busy || !name}>
              {busy ? "Importing…" : target ? "Import new version" : "Import skill"}
            </Button>{" "}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setPreview(null);
              }}
            >
              Cancel import
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}
