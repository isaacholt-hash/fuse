import { useCallback, useEffect, useRef, useState } from "react";
import type { FilesApi } from "@/files/api";
import {
  LARGE_TEXT_TOKENS,
  MAX_TEXT_TOKENS,
  prepareDocument as readDocument,
  type PreparedDocument,
} from "@/files/documents";
import { isImageType, type PreparedImage } from "@/files/images";
import type { Tenant } from "@/storage/defaults";
import { addFile, type FileMode, type FileRecord } from "@/storage/files";
import type { SqlDb } from "@/storage/sql";

/** A file in the composer, before it's sent. */
export interface PendingFile {
  id: string;
  name: string;
  status: "processing" | "ready" | "error";
  url?: string;
  file?: FileRecord;
  /** PDFs: page count, for the chip. */
  pages?: number;
  error?: string;
  /** Large text files: sent whole or searched (FK-03). Unset for everything else (whole). */
  mode?: FileMode;
}

/**
 * Composer attachments: each file is checked, resized, written to disk and recorded in the
 * database as soon as it's added, so sending is instant.
 */
export function useAttachments(deps: {
  db: SqlDb;
  tenant: Tenant;
  files: FilesApi;
  prepareImage: (file: File) => Promise<PreparedImage>;
  prepareDocument?: (file: File) => Promise<PreparedDocument>;
}) {
  const { db, tenant, files, prepareImage, prepareDocument = readDocument } = deps;
  const [pending, setPending] = useState<PendingFile[]>([]);
  const update = useCallback((id: string, change: Partial<PendingFile>) => {
    setPending((all) => all.map((p) => (p.id === id ? { ...p, ...change } : p)));
  }, []);

  const add = useCallback(
    (list: File[]) => {
      for (const f of list) {
        const id = crypto.randomUUID();
        const name = f.name || "Pasted image";
        setPending((all) => [...all, { id, name, status: "processing" }]);
        void (async () => {
          try {
            if (isImageType(f.type)) {
              const img = await prepareImage(f);
              const stored = await files.put(img.bytes);
              const file = await addFile(db, tenant, {
                name,
                mime: img.mime,
                sizeBytes: stored.size,
                sha256: stored.sha256,
                width: img.width,
                height: img.height,
              });
              const url = URL.createObjectURL(
                new Blob([new Uint8Array(img.bytes)], { type: img.mime }),
              );
              update(id, { status: "ready", file, url });
              return;
            }
            const doc = await prepareDocument(f);
            const stored = await files.put(doc.bytes);
            const file = await addFile(db, tenant, {
              name,
              mime: doc.mime,
              sizeBytes: stored.size,
              sha256: stored.sha256,
              tokenEstimate: doc.tokens,
            });
            // FK-03: big text files are searched by default; past the whole-file limit, always.
            const searched = doc.kind === "text" && doc.tokens > LARGE_TEXT_TOKENS;
            update(id, {
              status: "ready",
              file,
              ...(doc.pages ? { pages: doc.pages } : {}),
              ...(searched ? { mode: "retrieval" as const } : {}),
            });
          } catch (e) {
            update(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
          }
        })();
      }
    },
    [db, tenant, files, prepareImage, prepareDocument, update],
  );

  const release = (p: PendingFile) => {
    if (p.url) URL.revokeObjectURL(p.url);
  };
  const remove = (id: string) => {
    setPending((all) => {
      const gone = all.find((p) => p.id === id);
      if (gone) release(gone);
      return all.filter((p) => p.id !== id);
    });
  };
  /** Whole or searched, for a large text file; files over the whole-file limit stay searched. */
  const setMode = (id: string, mode: FileMode) => {
    setPending((all) =>
      all.map((p) =>
        p.id === id &&
        p.mode &&
        (mode === "retrieval" || (p.file?.tokenEstimate ?? 0) <= MAX_TEXT_TOKENS)
          ? { ...p, mode }
          : p,
      ),
    );
  };
  /** Hands over the ready files (with how each is sent) and empties the composer. */
  const take = (): FileRecord[] => {
    const ready = pending.flatMap((p) =>
      p.status === "ready" && p.file ? [{ ...p.file, ...(p.mode ? { mode: p.mode } : {}) }] : [],
    );
    pending.forEach(release);
    setPending([]);
    return ready;
  };
  const clear = () => {
    pending.forEach(release);
    setPending([]);
  };
  return { pending, add, remove, take, clear, setMode };
}

/** blob: URLs for stored images (thumbnails), loaded once per file and kept while the app runs. */
export function useFileUrls(files: FilesApi, wanted: FileRecord[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const f of wanted) {
      if (!f.mime.startsWith("image/")) continue;
      if (requested.current.has(f.sha256)) continue;
      requested.current.add(f.sha256);
      files.get(f.sha256).then(
        (bytes) => {
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: f.mime }));
          setUrls((all) => ({ ...all, [f.sha256]: url }));
        },
        () => {
          // Missing on disk: the thumbnail shows the file name instead.
        },
      );
    }
  }, [files, wanted]);
  return urls;
}
