export function parseCommand(command: string): { bin: string; args: string[] } {
  // Tokenize into bare words and quoted strings. Inside a quoted string,
  // `\<anychar>` is an escape (so `\"` keeps a literal quote and `\\` keeps
  // a literal backslash). Without this, `"value with \"nested\" quotes"`
  // would split at the first inner `"` and corrupt the argument.
  const parts = command.match(/(?:[^\s"]+|"(?:[^"\\]|\\.)*")+/g) ?? [];
  const stripQuotes = (p: string) => {
    if (!p.startsWith('"') || !p.endsWith('"')) return p;
    return p.slice(1, -1).replace(/\\(.)/g, "$1");
  };
  const bin = parts[0] ? stripQuotes(parts[0]) : command;
  const args = parts.slice(1).map(stripQuotes);
  return { bin, args };
}
