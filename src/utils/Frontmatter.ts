// ─── Frontmatter parser / serializer ─────────────────────────────────────────
//
// Handles the simple YAML-subset used in .devnotes/*.md files:
//   string, number, boolean, comma-separated tag list (tags field).
//
// Format rules:
//   • One key: value pair per line — multi-line values are not supported.
//   • Newlines inside string values are collapsed to a single space on write
//     so a malformed title can never break the closing --- delimiter.
//   • The closing --- must appear on its own line; --- embedded in a value
//     (e.g. title: foo --- bar) is safe because the parser matches \n--- only.
//
// No external dependencies.

export interface ParsedFile {
  meta: Record<string, unknown>;
  body: string;
}

// ── Parse ──────────────────────────────────────────────────────────────────

export function parseFrontmatter(raw: string): ParsedFile {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key) meta[key] = parseValue(val);
  }

  return { meta, body: match[2] };
}

function parseValue(val: string): unknown {
  if (val === 'true')  return true;
  if (val === 'false') return false;
  if (val === '')      return '';
  // Only coerce values that are unambiguously integers with no leading zeros.
  // Leading-zero strings (e.g. "007") and non-integer numerics are kept as
  // strings so that owner/branch fields are never silently converted to numbers.
  if (/^-?(0|[1-9]\d*)$/.test(val)) return Number(val);
  return val;
}

// ── Serialize ──────────────────────────────────────────────────────────────

export function serializeFrontmatter(
  meta: Record<string, unknown>,
  body: string
): string {
  const lines = Object.entries(meta).map(([key, val]) => {
    // Collapse newlines in string values — a \n inside a title would break
    // the closing --- delimiter when the file is parsed back.
    const safe = typeof val === 'string' ? val.replace(/\r?\n/g, ' ') : val;
    return `${key}: ${safe}`;
  });
  return `---\n${lines.join('\n')}\n---\n${body}`;
}
