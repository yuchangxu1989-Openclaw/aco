#!/usr/bin/env node
/**
 * ACO CLI bin 入口
 */
import { main } from './cli.js';

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
