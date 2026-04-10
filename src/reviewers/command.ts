export function parseCommand(command: string): { bin: string; args: string[] } {
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const bin = parts[0] ?? command;
  const args = parts.slice(1).map((p) => p.replace(/^"|"$/g, ""));
  return { bin, args };
}
