export function parseCommand(command: string): { bin: string; args: string[] } {
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const stripQuotes = (p: string) => p.replace(/^"|"$/g, "");
  const bin = parts[0] ? stripQuotes(parts[0]) : command;
  const args = parts.slice(1).map(stripQuotes);
  return { bin, args };
}
