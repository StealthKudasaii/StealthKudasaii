import 'dotenv/config';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'identifiant Discord invalide (17 à 20 chiffres)');
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'oui', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DISCORD_TOKEN: z.string().min(50, 'DISCORD_TOKEN manquant ou invalide'),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_CLIENT_SECRET: z.string().min(10, 'DISCORD_CLIENT_SECRET manquant'),
  GUILD_ID: snowflake,
  BOT_OWNER_IDS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(snowflake)),
  DATA_DIR: z.string().default('./data'),
  DATABASE_PATH: z.string().optional(),
  WEB_ENABLED: bool(true),
  WEB_HOST: z.string().default('0.0.0.0'),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url().default('http://localhost:3000').transform((u) => u.replace(/\/+$/, '')),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET doit faire au moins 32 caractères'),
  TRUST_PROXY: bool(false),
  TIMEZONE: z.string().default('Europe/Paris'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  BACKUP_RETENTION: z.coerce.number().int().min(1).max(365).default(14),
  REGISTER_COMMANDS_ON_START: bool(true),
  // Roblox (facultatif : /rewards fonctionne sans, mais sans liaison ni livraison en jeu)
  ROBLOX_OAUTH_CLIENT_ID: z.string().trim().optional().transform((v) => v || undefined),
  ROBLOX_OAUTH_CLIENT_SECRET: z.string().trim().optional().transform((v) => v || undefined),
  ROBLOX_OPEN_CLOUD_API_KEY: z.string().trim().optional().transform((v) => v || undefined),
  ROBLOX_UNIVERSE_ID: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined)
    .refine((v) => v === undefined || /^\d+$/.test(v), 'ROBLOX_UNIVERSE_ID doit être un nombre (Creator Dashboard → ton expérience)'),
  ROBLOX_DATASTORE: z.string().trim().default('RBKSRewards'),
  ROBLOX_MESSAGING_TOPIC: z.string().trim().default('RBKSRewards'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Lit et valide les variables d'environnement une seule fois. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuration invalide dans .env :\n${lines.join('\n')}\nVoir .env.example.`);
  }
  cached = parsed.data;
  return cached;
}

export function databasePath(): string {
  const e = env();
  return e.DATABASE_PATH ?? `${e.DATA_DIR.replace(/\/+$/, '')}/rbks.sqlite`;
}

/** Réservé aux tests. */
export function resetEnvCache(): void {
  cached = null;
}
