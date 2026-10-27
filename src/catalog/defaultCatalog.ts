import raw from "../../data/models.json";
import { parseCatalog, type Catalog } from "./catalog";

/** The catalog shipped with the app. Parsed (and validated) once at startup. */
export const defaultCatalog: Catalog = parseCatalog(raw);
