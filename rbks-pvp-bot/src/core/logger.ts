import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';

export const logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : level,
  redact: {
    paths: ['token', '*.token', 'DISCORD_TOKEN', 'clientSecret', '*.client_secret', 'headers.authorization', 'access_token'],
    censor: '[masqué]',
  },
  ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
});

export function childLogger(module: string) {
  return logger.child({ module });
}
