/**
 * The local model profiles (LL-02, LL-03, LL-08), from data/local-models.json. Each names one
 * GGUF file at a pinned revision with its SHA-256, size, licence and an estimate of the memory
 * it needs, so FUSE can say what an install costs before downloading anything.
 */
import raw from "../../data/local-models.json";
import type { CatalogModel } from "@/catalog/catalog";

export interface LocalProfile {
  id: string;
  displayName: string;
  file: string;
  quantization: string;
  url: string;
  revision: string;
  /** Lowercase hex. */
  sha256: string;
  sizeBytes: number;
  /** The file, the KV cache at `contextWindow` and working memory: an estimate until measured. */
  peakMemoryBytes: number;
  contextWindow: number;
  maxOutput: number;
  licence: string;
  licenceUrl: string;
  sourceUrl: string;
  notes?: string;
}

export interface LocalModels {
  verifiedOn: string;
  /** Largest first: the first that fits the computer is the one offered (step 5). */
  profiles: LocalProfile[];
}

class LocalModelsError extends Error {}

const text = (o: Record<string, unknown>, k: string, where: string): string => {
  const v = o[k];
  if (typeof v !== "string" || !v) throw new LocalModelsError(`${where}.${k}: expected text`);
  return v;
};
const count = (o: Record<string, unknown>, k: string, where: string): number => {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new LocalModelsError(`${where}.${k}: expected a positive whole number`);
  }
  return v;
};
const https = (o: Record<string, unknown>, k: string, where: string): string => {
  const v = text(o, k, where);
  // Model files come from Hugging Face only, at a pinned revision (LL-08).
  if (!v.startsWith("https://huggingface.co/")) {
    throw new LocalModelsError(`${where}.${k}: expected an https://huggingface.co/ URL`);
  }
  return v;
};

export function parseLocalModels(input: unknown): LocalModels {
  if (typeof input !== "object" || input === null) throw new LocalModelsError("expected an object");
  const root = input as Record<string, unknown>;
  const verifiedOn = text(root, "verified_on", "local-models");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(verifiedOn)) {
    throw new LocalModelsError("local-models.verified_on: expected YYYY-MM-DD");
  }
  if (!Array.isArray(root.profiles) || root.profiles.length === 0) {
    throw new LocalModelsError("local-models.profiles: expected a non-empty list");
  }
  const seen = new Set<string>();
  const profiles = root.profiles.map((p: unknown, i): LocalProfile => {
    const where = `profiles[${String(i)}]`;
    if (typeof p !== "object" || p === null)
      throw new LocalModelsError(`${where}: expected an object`);
    const o = p as Record<string, unknown>;
    const id = text(o, "id", where);
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id) || seen.has(id)) {
      throw new LocalModelsError(`${where}.id: expected a unique lowercase id`);
    }
    seen.add(id);
    const file = text(o, "file", where);
    if (!/^[A-Za-z0-9._-]+\.gguf$/.test(file)) {
      throw new LocalModelsError(`${where}.file: expected a plain .gguf file name`);
    }
    const revision = text(o, "revision", where);
    if (!/^[0-9a-f]{40}$/.test(revision)) {
      throw new LocalModelsError(`${where}.revision: expected a 40-character commit hash`);
    }
    const url = https(o, "url", where);
    if (!url.includes(`/resolve/${revision}/`) || !url.endsWith(`/${file}`)) {
      throw new LocalModelsError(`${where}.url: must name the pinned revision and the file`);
    }
    const sha256 = text(o, "sha256", where);
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new LocalModelsError(`${where}.sha256: expected 64 lowercase hex characters`);
    }
    const profile: LocalProfile = {
      id,
      displayName: text(o, "display_name", where),
      file,
      quantization: text(o, "quantization", where),
      url,
      revision,
      sha256,
      sizeBytes: count(o, "size_bytes", where),
      peakMemoryBytes: count(o, "peak_memory_bytes", where),
      contextWindow: count(o, "context_window", where),
      maxOutput: count(o, "max_output", where),
      licence: text(o, "licence", where),
      licenceUrl: https(o, "licence_url", where),
      sourceUrl: https(o, "source_url", where),
    };
    if (profile.peakMemoryBytes <= profile.sizeBytes) {
      throw new LocalModelsError(`${where}.peak_memory_bytes: must be more than the file`);
    }
    if (typeof o.notes === "string") profile.notes = o.notes;
    return profile;
  });
  for (let i = 1; i < profiles.length; i++) {
    if ((profiles[i]?.peakMemoryBytes ?? 0) > (profiles[i - 1]?.peakMemoryBytes ?? 0)) {
      throw new LocalModelsError("local-models.profiles: list the largest first");
    }
  }
  return { verifiedOn, profiles };
}

/** The profiles shipped with the app. */
export const localModels: LocalModels = parseLocalModels(raw);

/** A profile as a catalog model: provider `local`, priced at zero, never a cloud call. */
export function localCatalogModel(profile: LocalProfile, verifiedOn: string): CatalogModel {
  return {
    provider: "local",
    id: profile.id,
    displayName: profile.displayName,
    contextWindow: profile.contextWindow,
    maxOutput: profile.maxOutput,
    price: { input: 0, output: 0 },
    capabilities: ["streaming"],
    verifiedOn,
    sourceUrl: profile.sourceUrl,
    notes: `${profile.quantization} GGUF, ${profile.licence}. Runs on this computer.`,
  };
}
