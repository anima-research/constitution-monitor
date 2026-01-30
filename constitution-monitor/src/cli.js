#!/usr/bin/env node
/**
 * CLI script to run the constitution monitor
 * Used by GitHub Actions or manual execution
 */

import fs from 'fs/promises';
import { runMonitor } from './monitor.js';

async function main() {
  try {
    const result = await runMonitor();

    // Set GitHub Actions outputs if running in that environment
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      const outputs = [
        `changed=${result.changed}`,
        `hash=${result.hash}`,
        `summary=${(result.summary || '').replace(/\n/g, ' ')}`
      ].join('\n');

      await fs.appendFile(outputFile, outputs + '\n');
    }

    process.exit(result.changed ? 0 : 0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
