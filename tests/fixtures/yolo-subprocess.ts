import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createYoloSession, YOLO_ENV } from "./yolo-session.js";

const [cwd, agentDir, filename] = process.argv.slice(2);
if (!cwd || !agentDir || !filename) {
  throw new Error("Expected workspace, agent directory, and output filename arguments.");
}

const created = await createYoloSession(cwd, agentDir);
try {
  const result = await created.write(filename);
  const path = join(cwd, filename);
  const written = existsSync(path);
  console.log(JSON.stringify({
    ...result,
    written,
    content: written ? readFileSync(path, "utf8") : null,
    publishedYolo: process.env[YOLO_ENV],
  }));
} finally {
  created.session.dispose();
}
