import { Router } from 'express';
import multer from 'multer';
import { getClient, isBotReady } from '../../bot/client';
import { getSetting, setSetting } from '../../core/settings';
import { isHttpUrl } from '../../core/text';
import { updateAvatar, updateNickname, updatePresence, updateUsername } from '../../modules/botprofile';
import { audit } from '../../modules/audit/audit';
import { flash, requireFeature, verifyCsrf } from '../middleware';
import { action, field, FormError } from '../helpers';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mimetype)),
});

export function botRouter(): Router {
  const r = Router();
  r.use('/bot', requireFeature('bot.manage'));

  r.get('/bot', (_req, res) => {
    const u = isBotReady() ? getClient().user : null;
    res.render('bot', {
      title: 'Configuration du bot',
      botUser: u ? { username: u.username, avatar: u.displayAvatarURL({ size: 256 }), id: u.id } : null,
      presence: getSetting('bot.presence'),
      nickname: getSetting('bot.nickname'),
      brand: { name: getSetting('brand.name'), color: getSetting('brand.color'), footer: getSetting('brand.footer'), logoUrl: getSetting('brand.logoUrl') },
    });
  });

  r.post('/bot/username', (req, res) =>
    action(req, res, '/bot', async () => {
      const name = field.str(req.body, 'username', 32);
      if (name.length < 2) throw new FormError('Le nom doit faire entre 2 et 32 caractères.');
      const err = await updateUsername(name, req.member!.id);
      if (err) throw new FormError(err);
      return 'Nom du bot mis à jour sur Discord.';
    }),
  );

  r.post('/bot/nickname', (req, res) =>
    action(req, res, '/bot', async () => {
      const err = await updateNickname(field.str(req.body, 'nickname', 32), req.member!.id);
      if (err) throw new FormError(err);
      return 'Surnom du bot sur le serveur mis à jour.';
    }),
  );

  // Envoi de fichier : multer lit le formulaire, puis on vérifie le jeton CSRF.
  r.post('/bot/avatar', upload.single('avatar'), verifyCsrf, (req, res) =>
    action(req, res, '/bot', async () => {
      const url = field.str(req.body, 'avatarUrl', 500);
      let image: Buffer | string | null = null;
      if (req.file) image = req.file.buffer;
      else if (url) {
        if (!isHttpUrl(url)) throw new FormError('URL invalide.');
        image = url;
      }
      if (!image) throw new FormError('Choisis une image (PNG, JPG, GIF ou WEBP, 8 Mo max) ou indique une URL.');
      const err = await updateAvatar(image, req.member!.id);
      if (err) throw new FormError(err);
      return 'Avatar du bot mis à jour sur Discord.';
    }),
  );

  r.post('/bot/presence', (req, res) =>
    action(req, res, '/bot', async () => {
      await updatePresence(
        {
          status: field.oneOf(req.body, 'status', ['online', 'idle', 'dnd', 'invisible'] as const),
          activityType: field.oneOf(req.body, 'activityType', ['Playing', 'Watching', 'Listening', 'Competing', 'Custom'] as const),
          activityText: field.str(req.body, 'activityText', 128),
        },
        req.member!.id,
      );
      return 'Présence mise à jour.';
    }),
  );

  r.post('/bot/brand', (req, res) =>
    action(req, res, '/bot', async () => {
      const color = field.str(req.body, 'color', 7);
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new FormError('Couleur invalide (format #RRGGBB).');
      const logo = field.str(req.body, 'logoUrl', 500);
      if (logo && !isHttpUrl(logo)) throw new FormError('URL du logo invalide.');
      setSetting('brand.name', field.str(req.body, 'name', 60) || 'RBKS PVP');
      setSetting('brand.color', color);
      setSetting('brand.footer', field.str(req.body, 'footer', 120));
      setSetting('brand.logoUrl', logo);
      await audit({ type: 'admin', action: 'brand', actorId: req.member!.id, message: 'Identité visuelle des messages modifiée.' });
      flash(req, 'info', 'Les nouveaux messages utilisent la nouvelle identité. Republie les panneaux (Réglages) pour mettre à jour les anciens.');
      return 'Identité visuelle enregistrée.';
    }),
  );
  return r;
}
