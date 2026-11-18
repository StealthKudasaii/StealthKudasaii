// Prépare et vérifie le fichier .env avant le lancement (utilisé par lancer-bot.bat).
// Codes de sortie : 0 = prêt, 3 = .env à compléter.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env');
const example = path.join(root, '.env.example');

let created = false;
if (!fs.existsSync(envFile)) {
  let content = fs.readFileSync(example, 'utf8');
  // Secret de session généré automatiquement : rien à inventer pour cette valeur.
  content = content.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${crypto.randomBytes(48).toString('hex')}`);
  fs.writeFileSync(envFile, content, 'utf8');
  created = true;
}

const values = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const required = {
  DISCORD_TOKEN: 'Portail developpeur > Bot > Reset Token',
  DISCORD_CLIENT_ID: 'Portail developpeur > General Information > Application ID',
  DISCORD_CLIENT_SECRET: 'Portail developpeur > OAuth2 > Client Secret',
  GUILD_ID: 'Discord (mode developpeur) > clic droit sur le serveur > Copier l\'identifiant',
};
const missing = Object.keys(required).filter((k) => !values[k]);

if (created) console.log('\nUn fichier .env vient d\'etre cree (le secret de session est deja genere).');
if (missing.length) {
  console.log('\nIl reste a remplir dans .env :');
  for (const k of missing) console.log(`  - ${k}  (${required[k]})`);
  console.log('\nGuide detaille : docs\\DISCORD.md et docs\\OAUTH2.md');
  process.exit(3);
}
process.exit(0);
