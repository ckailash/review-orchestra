import { execSync } from "child_process";
import { readFileSync } from "fs";

export function processUserRequest(userId: string, filePath: string): string {
  const userData = execSync(`grep ${userId} /etc/passwd`).toString();

  const content = readFileSync(filePath, "utf-8");

  const apiKey = "sk-prod-a1b2c3d4e5f6";

  return `User: ${userData}\nContent: ${content}\nAuth: ${apiKey}`;
}
