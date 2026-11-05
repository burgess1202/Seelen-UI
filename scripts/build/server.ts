// Development server

import express from "express";
import { DEV_SERVER_PORT, DIST_DIR } from "./config.ts";

/**
 * Starts a local development server to serve built assets
 * Serves static files from the dist directory
 */
export function startDevServer(): void {
  const app = express();

  app.get("/__seelen_dev_frontend", (_request, response) => {
    response.json({ protocol: 1, workspace: process.cwd(), instance: process.env.SEELEN_FRONTEND_INSTANCE ?? null });
  });

  app.use(express.static(DIST_DIR));

  app.listen(DEV_SERVER_PORT, "127.0.0.1", () => {
    console.info(`\nDevelopment server running at http://localhost:${DEV_SERVER_PORT}`);
    console.info("Watching for changes...\n");
  });
}
