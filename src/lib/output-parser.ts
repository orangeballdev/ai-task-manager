export interface ParsedOutput {
  shouldRetry: boolean;
  retryAfter?: Date;
}

// Parse "5am", "3pm", "12:30am" etc. as the next occurrence of that UTC time.
function parseUtcAmPm(timeStr: string): Date | undefined {
  const normalized = timeStr.trim().toLowerCase().replace(/\s+/g, "");
  const m = normalized.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (!m) return undefined;
  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === "am") {
    if (hours === 12) hours = 0;
  } else {
    if (hours !== 12) hours += 12;
  }
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0, 0));
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}

// True if `index` falls inside an open double-quote span on its line — i.e. an
// odd number of `"` characters precede it since the last newline. Used to skip
// candidate matches that are just an agent quoting an example error string in
// its own prose (e.g. while describing this very detection logic), rather than
// a live occurrence: real CLI messages are emitted as plain, unquoted text.
// Apostrophes (as in "You've") are deliberately not counted — only `"`.
function isInsideQuotedSpan(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  const quoteCount = (prefix.match(/"/g) ?? []).length;
  return quoteCount % 2 === 1;
}

// High-confidence patterns: specific CLI/API error formats that don't occur naturally
// in Claude's assistant text — safe to match against any output, including info-level.
const HIGH_CONFIDENCE_PATTERNS: Array<{
  pattern: RegExp;
  extractTime?: (match: RegExpMatchArray) => Date | undefined;
}> = [
  // "You've hit your limit · resets 5am (UTC)" — Claude Pro subscription daily limit.
  // Also matches "session", "weekly", "daily", "monthly", "hourly", etc. limits.
  // The gap excludes quotes/newlines so this can't bridge across two separate
  // quoted phrases; isInsideQuotedSpan (applied in parseOutput) further skips
  // matches that are themselves inside quotes.
  {
    pattern: /hit your (?:\w+\s+)?limit[^"\n]{0,40}?resets?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*(?:\(UTC\))?/i,
    extractTime: (match) => parseUtcAmPm(match[1]),
  },
  // "You've hit your session/weekly/daily/monthly/hourly limit" without a reset
  // time — throttle for 1 hour by default. Kept to a known qualifier list (rather
  // than any word) so this stays specific to the CLI's usage-limit message and
  // doesn't fire on Claude innocently discussing "hit your limit" in its own text.
  {
    pattern: /hit your (?:session|weekly|daily|monthly|hourly)\s+limit/i,
  },
  {
    pattern: /try again after (\d+)\s*(second|minute|hour)?s?/i,
    extractTime: (match) => {
      const amount = parseInt(match[1], 10);
      const unit = (match[2] ?? "second").toLowerCase();
      const ms =
        unit === "hour"
          ? amount * 3600000
          : unit === "minute"
            ? amount * 60000
            : amount * 1000;
      return new Date(Date.now() + ms);
    },
  },
];

// Ambiguous patterns: generic phrases that Claude might mention innocuously when
// discussing rate limits in its own text. Only scan stderr / explicit error events.
const AMBIGUOUS_PATTERNS: Array<{
  pattern: RegExp;
  extractTime?: (match: RegExpMatchArray) => Date | undefined;
}> = [
  {
    pattern: /hit your limit/i,
  },
  {
    pattern: /ran out of tokens/i,
  },
  {
    pattern: /resets? at (.+)/i,
    extractTime: (match) => {
      const parsed = new Date(match[1]);
      if (!isNaN(parsed.getTime())) return parsed;
      return parseUtcAmPm(match[1].replace(/\s*\(UTC\)\s*$/, "").trim());
    },
  },
  {
    pattern: /(?:rate.?limit(?:ed)?|request.?limit(?:ed)?)\s+(?:exceeded|reached|hit)/i,
  },
  {
    pattern: /(?:exceeded|reached|hit)\s+(?:your\s+|the\s+)?(?:rate|request).?limit/i,
  },
  {
    pattern: /token.?(?:limit|quota)\s+(?:exceeded|reached|hit)/i,
  },
  {
    pattern: /(?:exceeded|reached|hit)\s+(?:your\s+|the\s+)?token.?(?:limit|quota)/i,
  },
  {
    pattern: /usage.?(?:limit|quota)\s+(?:exceeded|reached|hit)/i,
  },
  {
    pattern: /(?:exceeded|reached|hit)\s+(?:your\s+|the\s+)?usage.?(?:limit|quota)/i,
  },
];

export interface ParseOptions {
  /** When true, also match ambiguous patterns. Use for stderr / explicit error events. */
  includeAmbiguous?: boolean;
}

export function parseOutput(output: string, options: ParseOptions = {}): ParsedOutput {
  const patterns = options.includeAmbiguous
    ? [...HIGH_CONFIDENCE_PATTERNS, ...AMBIGUOUS_PATTERNS]
    : HIGH_CONFIDENCE_PATTERNS;
  for (const { pattern, extractTime } of patterns) {
    // Global copy so we can walk every candidate occurrence, not just the first —
    // a quoted example earlier in the text shouldn't hide a real, later match.
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    for (const match of output.matchAll(globalPattern)) {
      if (isInsideQuotedSpan(output, match.index)) continue;
      return {
        shouldRetry: true,
        retryAfter: extractTime ? extractTime(match) : new Date(Date.now() + 3600000),
      };
    }
  }
  return { shouldRetry: false };
}
