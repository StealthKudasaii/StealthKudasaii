# Configurer OAuth2 pour le panel web

Le panel utilise « Se connecter avec Discord ». Seul le scope `identify` est demandé : le panel connaît ton identifiant et ton pseudo, rien d’autre. L’accès est ensuite décidé par tes **rôles sur le serveur RBKS PVP**.

## 1. Client Secret

1. <https://discord.com/developers/applications> → ton application → onglet **OAuth2**.
2. **Client Secret** → **Reset Secret** → copie la valeur. C’est `DISCORD_CLIENT_SECRET`.
   - ⚠️ Secret à garder privé, comme le token.

## 2. URL de redirection

Toujours dans **OAuth2 → Redirects** → **Add Redirect**. L’URL est `PUBLIC_URL` suivi de `/auth/callback` :

| Situation | `PUBLIC_URL` dans `.env` | Redirect à ajouter dans Discord |
|---|---|---|
| Test sur ton PC | `http://localhost:3000` | `http://localhost:3000/auth/callback` |
| Serveur avec domaine (recommandé) | `https://panel.ton-domaine.fr` | `https://panel.ton-domaine.fr/auth/callback` |

L’URL doit correspondre **exactement** (protocole, domaine, port, pas de `/` final dans `PUBLIC_URL`). **Save Changes**.

Tu peux ajouter les deux redirections en même temps.

## 3. Secret de session

Génère une chaîne aléatoire pour `SESSION_SECRET` :

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Changer ce secret déconnecte tout le monde du panel.

## 4. Vérifier

1. Démarre le bot (`npm start`) et ouvre `PUBLIC_URL`.
2. **Se connecter avec Discord** → autorise.
3. Tu arrives sur le tableau de bord si ton compte a un rôle autorisé pour « Accès au panel web » (par défaut : Fondateur, Co-Fondateur, Administrateur ; le propriétaire du serveur a toujours accès).

## Problèmes fréquents

| Message | Cause probable |
|---|---|
| « Discord a refusé la connexion » | Redirect absent ou différent de `PUBLIC_URL/auth/callback`, ou mauvais `DISCORD_CLIENT_SECRET`. |
| « Invalid OAuth2 redirect_uri » (page Discord) | Même cause : l’URL n’est pas enregistrée à l’identique. |
| « Accès refusé » | Ton compte n’a pas de rôle autorisé (voir `/permissions view`) ou n’est pas sur le serveur. |
| « Paramètre de sécurité invalide » | La connexion a expiré ou les cookies sont bloqués : recommence. En HTTPS derrière un proxy, mets `TRUST_PROXY=true`. |
