import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';

/** Informations écrites par deploy/update.sh à chaque mise à jour automatique. */
export interface DeployInfo {
  status: 'updated' | 'rollback';
  commit: string;
  previous: string;
  message: string;
  reason?: string;
  at: string;
  announced?: boolean;
}

const file = () => path.resolve(env().DATA_DIR, 'deploy.json');

export function readDeployInfo(): DeployInfo | null {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as DeployInfo;
  } catch {
    return null;
  }
}

export function markDeployAnnounced(): void {
  const info = readDeployInfo();
  if (!info) return;
  fs.writeFileSync(file(), JSON.stringify({ ...info, announced: true }, null, 2));
}
