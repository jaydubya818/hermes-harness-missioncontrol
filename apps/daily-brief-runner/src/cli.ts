// One-shot CLI: run a brief now, print result, exit. No server, no cron.
// Usage: pnpm --filter daily-brief-runner run:once

import { loadConfig, runOnce } from "./runner.js";

const config = loadConfig();
const result = await runOnce(config);
console.log(JSON.stringify({ delivery: result.delivery, warnings: result.brief.warnings }, null, 2));
process.exit(result.delivery.ok ? 0 : 1);
