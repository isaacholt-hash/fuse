// Math in answers (CH-01): rewrites the delimiters models use into what remark-math reads.

/**
 * Models write math as \(…\) and \[…\] as often as with dollars; remark-math reads $$…$$ (inline
 * or on its own lines). Single $ isn't math here, so "$5 and $10" stays money. Code is left alone.
 */
export function normaliseMath(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$$${m.trim()}$$`),
    )
    .join("");
}
