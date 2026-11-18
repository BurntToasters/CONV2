import crypto from "node:crypto";
import fs from "node:fs";

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}
