import { Router } from 'express';
import { PUBLICATION_KINDS, type PublicationKind } from '../../config/constants';
import { publications, publishPublication } from '../../modules/publications';
import { audit } from '../../modules/audit/audit';
import { isHttpUrl } from '../../core/text';
import { requireFeature } from '../middleware';
import { action, field, FormError } from '../helpers';

export function publicationsRouter(): Router {
  const r = Router();
  r.use('/publications', requireFeature('publications.manage'));

  r.get('/publications', (req, res) => {
    const edit = req.query.edit ? publications.get(Number(req.query.edit)) : undefined;
    res.render('publications', { title: 'Annonces et patch notes', list: publications.list(undefined, 50), edit });
  });

  r.post('/publications', (req, res) =>
    action(req, res, '/publications', async () => {
      const id = field.int(req.body, 'id', 1, 1e9);
      const kind = field.oneOf(req.body, 'kind', Object.keys(PUBLICATION_KINDS) as PublicationKind[]);
      const title = field.str(req.body, 'title', 200);
      if (!title) throw new FormError('Le titre est obligatoire.');
      const image = field.optStr(req.body, 'image_url', 500);
      if (image && !isHttpUrl(image)) throw new FormError('URL d’image invalide.');
      const data = {
        kind,
        version: field.optStr(req.body, 'version', 20),
        title,
        description: field.str(req.body, 'description', 4000),
        features: field.str(req.body, 'features', 1000),
        fixes: field.str(req.body, 'fixes', 1000),
        balance: field.str(req.body, 'balance', 1000),
        image_url: image,
        publish_date: field.date(req.body, 'publish_date') ?? Date.now(),
        ping: field.bool(req.body, 'ping'),
      };
      if (kind === 'patchnote' && !data.version) throw new FormError('Le numéro de version est obligatoire pour un patch note.');
      let pid = id;
      if (id) {
        const existing = publications.get(id);
        if (!existing) throw new FormError('Publication introuvable.');
        if (existing.kind !== kind && existing.message_id) throw new FormError('Impossible de changer le type d’une publication déjà envoyée.');
        publications.update(id, data);
      } else pid = publications.create(data, req.member!.id);
      const p = await publishPublication(pid!);
      if (id) await audit({ type: 'publications', action: `${kind}_edit`, actorId: req.member!.id, target: title, message: `${PUBLICATION_KINDS[kind].label} « ${title} » modifiée depuis le panel.` });
      return `${PUBLICATION_KINDS[kind].label} ${id ? 'mise à jour' : 'publiée'} sur Discord (salon ${p.channel_id}).`;
    }),
  );
  return r;
}
