/**
 * Deterministic first (LL-01): questions that a fixed rule answers exactly, with no model. Each
 * handler matches its whole question strictly and returns null otherwise, so anything with more
 * to it (an explanation, a judgement) still goes to a model. Pure TypeScript: no shell, no
 * network, no model output is ever run. Inputs are capped and a slow handler is discarded.
 */

export type HandlerId = "arithmetic" | "units" | "dates" | "count" | "json" | "csv";

export const HANDLER_LABELS: Record<HandlerId, string> = {
  arithmetic: "Arithmetic",
  units: "Unit conversion",
  dates: "Dates and times",
  count: "Counting",
  json: "JSON check",
  csv: "CSV check",
};

export interface DeterministicAnswer {
  handler: HandlerId;
  answer: string;
}

/** Longer questions go to a model: no handler needs more, and it bounds every handler's work. */
export const MAX_INPUT = 100_000;
/** A handler that takes longer than this is ignored and the question goes to a model. */
export const TIME_LIMIT_MS = 100;

/** Up to 12 significant digits, no trailing zeros, no exponent for ordinary sizes. */
export function formatNumber(n: number): string {
  if (Object.is(n, -0)) return "0";
  const rounded = Number(n.toPrecision(12));
  if (Math.abs(rounded) >= 1e21 || (rounded !== 0 && Math.abs(rounded) < 1e-9)) {
    return rounded.toExponential().replace(/\.?0+e/, "e");
  }
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 12, useGrouping: true });
}

// ---------------------------------------------------------------- arithmetic

const ASK = /^(?:what(?:'s| is)|calculate|compute|evaluate|work out|solve)\s+/i;

/** Thousands separators only in their usual places ("1,000", not "1,00"). */
const NUMBER = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|^\.\d+/;

/** + - * / ^ and parentheses, with × ÷ − accepted; depth-limited recursive descent. */
export function evaluate(source: string): number | null {
  const s = source.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/\*\*/g, "^");
  let i = 0;
  let depth = 0;
  const space = () => {
    while (s[i] === " ") i++;
  };
  const fail = (): never => {
    throw new Error("parse");
  };
  const primary = (): number => {
    space();
    if (s[i] === "(") {
      if (++depth > 50) fail();
      i++;
      const v = sum();
      space();
      if (s[i] !== ")") fail();
      i++;
      depth--;
      return v;
    }
    if (s[i] === "-" || s[i] === "+") {
      const sign = s[i] === "-" ? -1 : 1;
      i++;
      if (++depth > 50) fail();
      const v = sign * power();
      depth--;
      return v;
    }
    const m = NUMBER.exec(s.slice(i));
    if (!m) return fail();
    i += m[0].length;
    return Number(m[0].replace(/,/g, ""));
  };
  const power = (): number => {
    const base = primary();
    space();
    if (s[i] === "^") {
      i++;
      if (++depth > 50) fail();
      const v = base ** power(); // right-associative
      depth--;
      return v;
    }
    return base;
  };
  const product = (): number => {
    let v = power();
    for (;;) {
      space();
      const op = s[i];
      if (op !== "*" && op !== "/") return v;
      i++;
      const r = power();
      if (op === "/" && r === 0) fail();
      v = op === "*" ? v * r : v / r;
    }
  };
  const sum = (): number => {
    let v = product();
    for (;;) {
      space();
      const op = s[i];
      if (op !== "+" && op !== "-") return v;
      i++;
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
  };
  try {
    const v = sum();
    space();
    return i === s.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function arithmetic(q: string): string | null {
  const percent =
    /^(?:what(?:'s| is)\s+)?(\d+(?:\.\d+)?)\s*%\s+of\s+(-?\d[\d,]*(?:\.\d+)?)\s*\??$/i.exec(q);
  if (percent?.[1] && percent[2]) {
    const of = evaluate(percent[2]);
    if (of === null) return null;
    const v = (Number(percent[1]) / 100) * of;
    return `${percent[1]}% of ${percent[2]} = ${formatNumber(v)}`;
  }
  const asked = ASK.test(q);
  const expr = q
    .replace(ASK, "")
    .replace(/\s*(?:=|\?)+\s*$/, "")
    .trim();
  // "2026-10-30" or "555-1234" on their own are a date or a number, not a sum.
  if (!asked && /^\d+(?:-\d+)+$/.test(expr)) return null;
  // Digits and operators only, with at least one operator between two numbers.
  if (!/^[\d\s.,+\-*/^()×÷−]+$/.test(expr) || !/\d\s*[-+*/^×÷−]\s*[-+(.\d]/.test(expr)) {
    return null;
  }
  const v = evaluate(expr);
  return v === null ? null : `${expr} = ${formatNumber(v)}`;
}

// ---------------------------------------------------------------- units

interface Unit {
  kind: "length" | "mass" | "volume" | "data" | "time" | "temperature";
  /** Size in the kind's base unit (metre, gram, litre, byte, second); unused for temperature. */
  size: number;
  symbol: string;
}

const UNITS: Record<string, Unit> = {};
function unit(kind: Unit["kind"], size: number, symbol: string, names: string[]) {
  for (const n of [symbol, ...names]) UNITS[n.toLowerCase()] = { kind, size, symbol };
}
unit("length", 0.001, "mm", ["millimetre", "millimetres", "millimeter", "millimeters"]);
unit("length", 0.01, "cm", ["centimetre", "centimetres", "centimeter", "centimeters"]);
unit("length", 1, "m", ["metre", "metres", "meter", "meters"]);
unit("length", 1000, "km", ["kilometre", "kilometres", "kilometer", "kilometers"]);
unit("length", 0.0254, "in", ["inch", "inches"]);
unit("length", 0.3048, "ft", ["foot", "feet"]);
unit("length", 0.9144, "yd", ["yard", "yards"]);
unit("length", 1609.344, "mi", ["mile", "miles"]);
unit("mass", 0.001, "mg", ["milligram", "milligrams"]);
unit("mass", 1, "g", ["gram", "grams"]);
unit("mass", 1000, "kg", ["kilogram", "kilograms", "kilo", "kilos"]);
unit("mass", 28.349523125, "oz", ["ounce", "ounces"]);
unit("mass", 453.59237, "lb", ["lbs", "pound", "pounds"]);
unit("mass", 1_000_000, "t", ["tonne", "tonnes"]);
unit("volume", 0.001, "ml", ["millilitre", "millilitres", "milliliter", "milliliters"]);
unit("volume", 1, "l", ["litre", "litres", "liter", "liters"]);
unit("volume", 3.785411784, "gal", ["gallon", "gallons", "us gallon", "us gallons"]);
unit("volume", 0.0295735295625, "fl oz", ["fluid ounce", "fluid ounces"]);
unit("data", 1, "B", ["byte", "bytes"]);
unit("data", 1e3, "KB", ["kilobyte", "kilobytes"]);
unit("data", 1e6, "MB", ["megabyte", "megabytes"]);
unit("data", 1e9, "GB", ["gigabyte", "gigabytes"]);
unit("data", 1e12, "TB", ["terabyte", "terabytes"]);
unit("data", 1024, "KiB", ["kibibyte", "kibibytes"]);
unit("data", 1024 ** 2, "MiB", ["mebibyte", "mebibytes"]);
unit("data", 1024 ** 3, "GiB", ["gibibyte", "gibibytes"]);
unit("data", 1024 ** 4, "TiB", ["tebibyte", "tebibytes"]);
unit("time", 1, "s", ["sec", "secs", "second", "seconds"]);
unit("time", 60, "min", ["mins", "minute", "minutes"]);
unit("time", 3600, "h", ["hr", "hrs", "hour", "hours"]);
unit("time", 86_400, "days", ["day"]);
unit("time", 604_800, "weeks", ["week", "wk", "wks"]);
unit("temperature", 0, "°C", ["c", "celsius", "degrees c", "degrees celsius", "°c"]);
unit("temperature", 0, "°F", ["f", "fahrenheit", "degrees f", "degrees fahrenheit", "°f"]);
unit("temperature", 0, "K", ["kelvin", "kelvins"]);

const toKelvin: Record<string, (v: number) => number> = {
  "°C": (v) => v + 273.15,
  "°F": (v) => ((v - 32) * 5) / 9 + 273.15,
  K: (v) => v,
};
const fromKelvin: Record<string, (k: number) => number> = {
  "°C": (k) => k - 273.15,
  "°F": (k) => ((k - 273.15) * 9) / 5 + 32,
  K: (k) => k,
};

function units(q: string): string | null {
  const m =
    /^(?:convert\s+|what(?:'s| is)\s+)?(-?\d[\d,]*(?:\.\d+)?)\s*([a-z°][a-z° ]*?)\s+(?:to|in|into)\s+([a-z°][a-z° ]*?)\s*\??$/i.exec(
      q,
    );
  if (!m?.[1] || !m[2] || !m[3]) return null;
  // Units are case-sensitive only where it matters: "B" bytes, "MB" vs "mb" both megabytes.
  const from = UNITS[m[2].toLowerCase()];
  const to = UNITS[m[3].toLowerCase()];
  if (!from || !to || from.kind !== to.kind || from.symbol === to.symbol) return null;
  const value = evaluate(m[1]);
  if (value === null) return null;
  let out: number;
  if (from.kind === "temperature") {
    const k = toKelvin[from.symbol]?.(value);
    const conv = fromKelvin[to.symbol];
    if (k === undefined || !conv) return null;
    out = conv(k);
  } else {
    out = (value * from.size) / to.size;
  }
  return `${formatNumber(value)} ${from.symbol} = ${formatNumber(out)} ${to.symbol}`;
}

// ---------------------------------------------------------------- dates

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A calendar date as days since the epoch (UTC), from YYYY-MM-DD, "today" or "tomorrow". */
function parseDay(s: string, now: number): number | null {
  const t = s.trim().toLowerCase();
  const local = new Date(now);
  const today = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) / DAY_MS;
  if (t === "today") return today;
  if (t === "tomorrow") return today + 1;
  if (t === "yesterday") return today - 1;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Rejects 2026-02-30 and the like, which Date would roll over.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms / DAY_MS;
}

const iso = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const weekday = (day: number) => WEEKDAYS[new Date(day * DAY_MS).getUTCDay()] ?? "";
const DATE = String.raw`(\d{4}-\d{2}-\d{2}|today|tomorrow|yesterday)`;

/** A time of day ("15:00", "3pm", "3:30 pm") as minutes after midnight. */
function parseTime(s: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m?.[1]) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm === "pm" ? 12 : 0);
  } else if (h > 23 || !m[2]) {
    return null; // "3" alone isn't a time
  }
  return h * 60 + min;
}

function validZone(zone: string): string | null {
  const z = zone.trim();
  if (/^utc$|^gmt$/i.test(z)) return "UTC";
  if (!/^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(z)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: z }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Minutes a zone is ahead of UTC at an instant. */
function zoneOffset(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - Math.floor(at / 60_000) * 60_000) / 60_000);
}

function dates(q: string, now: number): string | null {
  const s = q.replace(/\?\s*$/, "").trim();
  let m = new RegExp(String.raw`^what day(?: of the week)? (?:is|was|will be) ${DATE}$`, "i").exec(
    s,
  );
  if (m?.[1]) {
    const d = parseDay(m[1], now);
    return d === null ? null : `${iso(d)} is a ${weekday(d)}.`;
  }
  m = new RegExp(
    String.raw`^(?:how many )?days (?:are there )?(?:between|from) ${DATE} (?:and|to|until) ${DATE}$`,
    "i",
  ).exec(s);
  if (m?.[1] && m[2]) {
    const a = parseDay(m[1], now);
    const b = parseDay(m[2], now);
    if (a === null || b === null) return null;
    const n = Math.abs(b - a);
    return `${String(n)} day${n === 1 ? "" : "s"} from ${iso(Math.min(a, b))} to ${iso(Math.max(a, b))}.`;
  }
  m =
    new RegExp(
      String.raw`^(?:what(?:'s| is) )?${DATE} (plus|minus|\+|-) (\d{1,6}) days?$`,
      "i",
    ).exec(s) ?? null;
  const after = new RegExp(
    String.raw`^(?:what(?:'s| is) )?(\d{1,6}) days? (after|from|before) ${DATE}$`,
    "i",
  ).exec(s);
  if (m?.[1] && m[2] && m[3]) {
    const d = parseDay(m[1], now);
    if (d === null) return null;
    const n = Number(m[3]) * (m[2] === "minus" || m[2] === "-" ? -1 : 1);
    return `${iso(d + n)} (${weekday(d + n)}).`;
  }
  if (after?.[1] && after[2] && after[3]) {
    const d = parseDay(after[3], now);
    if (d === null) return null;
    const n = Number(after[1]) * (after[2].toLowerCase() === "before" ? -1 : 1);
    return `${iso(d + n)} (${weekday(d + n)}).`;
  }
  // "convert 15:00 UTC to Asia/Tokyo": today's date, so daylight saving is right for today.
  m =
    /^(?:convert |what(?:'s| is) )?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?) ([A-Za-z_/]+) (?:to|in) ([A-Za-z_/]+)$/i.exec(
      s,
    );
  if (m?.[1] && m[2] && m[3]) {
    const minutes = parseTime(m[1]);
    const from = validZone(m[2]);
    const to = validZone(m[3]);
    if (minutes === null || !from || !to || from === to) return null;
    const local = new Date(now);
    const wall =
      Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) + minutes * 60_000;
    // The instant whose wall clock in `from` reads `wall` (offset taken at that instant).
    const instant = wall - zoneOffset(from, wall - zoneOffset(from, wall) * 60_000) * 60_000;
    const out = wall + (zoneOffset(to, instant) - zoneOffset(from, instant)) * 60_000;
    const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    const dayShift = Math.floor(out / DAY_MS) - Math.floor(wall / DAY_MS);
    const shift = dayShift === 0 ? "" : dayShift > 0 ? " (the next day)" : " (the day before)";
    return `${hhmm(wall)} ${from} is ${hhmm(out)} ${to}${shift}, today.`;
  }
  return null;
}

// ---------------------------------------------------------------- counting

function count(q: string): string | null {
  const m =
    /^(?:count (?:the )?|how many )(words|characters|chars|lines)(?: are there| are| is there)? (?:in|of)(?: this| the following)?(?: text)?\s*[:\n]\s*([\s\S]+)$/i.exec(
      q,
    );
  if (!m?.[1] || !m[2]) return null;
  let text = m[2];
  const quoted = /^(["“'`])([\s\S]*)(["”'`])$/.exec(text.trim());
  if (quoted?.[2] !== undefined) text = quoted[2];
  const what = m[1].toLowerCase();
  if (what === "words") {
    const n = text.trim() ? text.trim().split(/\s+/).length : 0;
    return `${formatNumber(n)} word${n === 1 ? "" : "s"}.`;
  }
  if (what === "lines") {
    const n = text.replace(/\n$/, "").split("\n").length;
    return `${formatNumber(n)} line${n === 1 ? "" : "s"}.`;
  }
  // Characters as people count them (grapheme clusters), so "é" or an emoji is one.
  const graphemes = (t: string) =>
    Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(t)).length;
  const all = graphemes(text);
  const noSpaces = graphemes(text.replace(/\s/g, ""));
  return `${formatNumber(all)} characters (${formatNumber(noSpaces)} without spaces).`;
}

// ---------------------------------------------------------------- JSON and CSV

const CHECK =
  /^(?:is (?:this|the following) (?:valid )?|validate (?:this |the following )?|check (?:this |the following )?(?:is valid )?)(json|csv)\??\s*[:\n]\s*([\s\S]+)$/i;

function unfence(body: string): string {
  const f = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(body.trim());
  return f?.[1] ?? body.trim();
}

function json(body: string): string {
  try {
    const v: unknown = JSON.parse(body);
    const what = Array.isArray(v)
      ? `an array of ${formatNumber(v.length)} item${v.length === 1 ? "" : "s"}`
      : v !== null && typeof v === "object"
        ? `an object with ${formatNumber(Object.keys(v).length)} key${Object.keys(v).length === 1 ? "" : "s"}`
        : `a ${v === null ? "null" : typeof v}`;
    return `Valid JSON: ${what}.`;
  } catch (e) {
    return `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
function csvRows(text: string): string[][] | string {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      if (field !== "") return `a quote inside an unquoted field on row ${String(rows.length + 1)}`;
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) return "a quoted field that never closes";
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csv(body: string): string {
  const rows = csvRows(body);
  if (typeof rows === "string") return `Not valid CSV: ${rows}.`;
  if (rows.length === 0) return "Not valid CSV: it's empty.";
  const width = rows[0]?.length ?? 0;
  const bad = rows.findIndex((r) => r.length !== width);
  if (bad >= 0) {
    return `Not valid CSV: row ${String(bad + 1)} has ${String(rows[bad]?.length ?? 0)} fields, but row 1 has ${String(width)}.`;
  }
  return `Valid CSV: ${formatNumber(rows.length)} row${rows.length === 1 ? "" : "s"} (header included), ${formatNumber(width)} column${width === 1 ? "" : "s"}.`;
}

function check(q: string): { handler: "json" | "csv"; answer: string } | null {
  const m = CHECK.exec(q);
  if (!m?.[1] || !m[2]) return null;
  const kind = m[1].toLowerCase() === "json" ? "json" : "csv";
  const body = unfence(m[2]);
  return { handler: kind, answer: kind === "json" ? json(body) : csv(body) };
}

// ---------------------------------------------------------------- entry

/**
 * The answer when a handler matches the whole question, else null (the question goes to a
 * model). `now` is the clock for "today" and time zones.
 */
export function answerWithoutModel(question: string, now: number): DeterministicAnswer | null {
  const q = question.trim();
  if (!q || q.length > MAX_INPUT) return null;
  const started = performance.now();
  const short = q.length <= 300 && !q.includes("\n");
  const found: DeterministicAnswer | null = (() => {
    const c = check(q);
    if (c) return c;
    const n = count(q);
    if (n) return { handler: "count", answer: n };
    if (!short) return null;
    const a = arithmetic(q);
    if (a) return { handler: "arithmetic", answer: a };
    const u = units(q);
    if (u) return { handler: "units", answer: u };
    const d = dates(q, now);
    if (d) return { handler: "dates", answer: d };
    return null;
  })();
  return found && performance.now() - started <= TIME_LIMIT_MS ? found : null;
}
