import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function findOpenclawConfigPath(): string | undefined {
  const candidates = [
    ...(process.env.OPENCLAW_HOME ? [join(process.env.OPENCLAW_HOME, 'openclaw.json')] : []),
    join(process.cwd(), 'openclaw.json'),
    join(homedir(), '.openclaw', 'openclaw.json'),
  ];

  return candidates.find(candidate => existsSync(candidate));
}

export function resolveAcoDataDir(openclawConfigPath?: string): string {
  if (process.env.ACO_DATA_DIR) return resolve(process.env.ACO_DATA_DIR);
  if (openclawConfigPath) return join(dirname(openclawConfigPath), 'aco-data');

  const detectedOpenclawConfig = findOpenclawConfigPath();
  if (detectedOpenclawConfig) return join(dirname(detectedOpenclawConfig), 'aco-data');

  return resolve(process.cwd(), '.aco');
}
