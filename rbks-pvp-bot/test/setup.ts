// Variables d'environnement factices pour les tests (aucun appel réel à Discord).
process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN = 'x'.repeat(72);
process.env.DISCORD_CLIENT_ID = '100000000000000001';
process.env.DISCORD_CLIENT_SECRET = 'test-secret-value';
process.env.GUILD_ID = '200000000000000002';
process.env.SESSION_SECRET = 's'.repeat(48);
process.env.DATABASE_PATH = ':memory:';
process.env.DATA_DIR = require('node:path').join(require('node:os').tmpdir(), 'rbks-test-' + process.pid);
process.env.TIMEZONE = 'Europe/Paris';
