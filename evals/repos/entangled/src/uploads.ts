import { writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const UPLOAD_DIR = "/var/app/uploads";
const MAX_FILENAME_LENGTH = 255;

export function saveUpload(
  filename: string,
  content: Buffer
): { path: string; size: number } {
  if (filename.length > MAX_FILENAME_LENGTH) {
    throw new Error("Filename too long");
  }

  const filePath = path.join(UPLOAD_DIR, filename);

  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }

  writeFileSync(filePath, content);

  return { path: filePath, size: content.length };
}

export function saveUploadExclusive(
  filename: string,
  content: Buffer
): { path: string; size: number } {
  const filePath = path.join(UPLOAD_DIR, filename);

  if (existsSync(filePath)) {
    throw new Error("File already exists");
  }

  writeFileSync(filePath, content);
  return { path: filePath, size: content.length };
}
