# Bot or : Telegram → Claude → MetaTrader 5

Ce bot lit un groupe Telegram de signaux sur l'or (XAUUSD). Il comprend les messages grâce à Claude, vérifie le graphique au moment du signal, puis passe les ordres sur MT5. Il place les TP multiples, déplace le SL au break-even et le remonte ensuite, avec des limites de risque fixes que l'IA ne peut pas contourner.

> ⚠️ **Ce n'est pas un conseil financier.** Le trading de l'or à effet de levier peut faire perdre plus vite qu'on ne le pense. Si les signaux du groupe sont perdants sur la durée, le bot perdra aussi. Commence en `dry_run`, puis sur un **compte démo** pendant plusieurs semaines.

## Comment ça marche

```
Message Telegram ──► Claude Haiku : « est-ce un signal ? » → JSON (sens, zone, SL, TP, ou consigne)
                       │
                       ▼
              Claude Opus : analyse M5/M15/H1/H4 (EMA, RSI, ATR, structure, niveaux)
              → APPROVE / REDUCE (taille réduite) / REJECT
                       │
                       ▼
              Moteur de risque (code, pas d'IA) : SL obligatoire, spread, heure,
              doublons, perte max du jour, nb de trades, taille du lot
                       │
                       ▼
              MT5 : 1 position par TP (ex. 50 % TP1, 30 % TP2, 20 % TP3), même SL
                       │
                       ▼
              Gestion continue : TP1 → SL au BE (+ marge) ; TP2 → SL sur TP1 ; …
              + consignes du groupe : « SL BE », « close all », « close half », nouveau SL/TP, « cancel »
                       │
                       ▼
              Notifications dans tes « Messages enregistrés » Telegram
```

Ce que le bot gère :
- **Zone d'entrée** : si le prix est dans la zone (ou à moins de `max_entry_drift` $), il entre au marché. Sinon, il place un ordre limite au prix du signal, qui expire au bout de 2 h par défaut.
- **Trop tard** : si le prix a déjà touché le TP1 ou dépassé le SL, il ne prend pas le trade.
- **Signal édité** par l'admin : le SL et les TP du trade ouvert sont mis à jour.
- **Signal ambigu** (certitude de l'IA < 70 %) : rien n'est pris, tu reçois une notification.
- **Pas de TP dans le signal** : les TP sont placés à 1R, 2R et 3R.
- **IA injoignable** : le bot suit le signal à risque réduit de moitié (réglable).

## Installation (VPS Windows ou PC Windows allumé en permanence)

La librairie Python de MetaTrader 5 ne fonctionne **que sous Windows**. Un VPS Windows coûte environ 15 à 30 €/mois. Prends-le près des serveurs de ton broker (souvent Londres ou New York).

1. Installe **MetaTrader 5** depuis le site de ton broker, connecte-toi à ton compte **démo** et laisse le terminal ouvert. Dans `Outils > Options > Expert Advisors`, coche **« Autoriser le trading algorithmique »**, puis active le bouton **Algo Trading** dans la barre d'outils.
2. Installe **Python 3.11 ou plus récent** (python.org, coche « Add to PATH »).
3. Dans un terminal, dans ce dossier :
   ```
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   ```
4. Copie `.env.example` en `.env` et remplis-le :
   - `ANTHROPIC_API_KEY` : sur platform.claude.com (ajoute 10 à 20 $ de crédit, ça dure longtemps).
   - `TELEGRAM_API_ID` et `TELEGRAM_API_HASH` : sur my.telegram.org > API development tools.
   - `MT5_LOGIN`, `MT5_PASSWORD`, `MT5_SERVER` : ceux de ton compte démo.
5. Trouve l'ID du groupe : `python -m bot.list_chats`. Au premier lancement, Telegram demande ton numéro puis le code reçu dans l'app. La session est ensuite enregistrée dans `data/`.
6. Copie `config.example.yaml` en `config.yaml`. Mets l'ID du groupe dans `source_chats` et le **nom exact de l'or chez ton broker** dans `mt5.symbol` (regarde dans la fenêtre « Market Watch » de MT5 : `XAUUSD`, `XAUUSD.m`, `GOLD`…).
7. Lance le bot : `python -m bot.main`

## Les étapes pour passer en réel sans se brûler

1. **`dry_run: true`** (par défaut), pendant quelques jours : le bot lit, analyse et te dit ce qu'il *aurait* fait, sans envoyer d'ordre. Vérifie qu'il comprend bien chaque message du groupe.
2. **`dry_run: false` sur un compte démo**, pendant 2 à 4 semaines : vrais ordres, argent fictif. Compare avec les résultats annoncés par le groupe.
3. **En réel**, seulement si les résultats en démo sont bons, avec un petit `risk_per_trade_pct` (0,5 %) au début.

## Backtest : rejouer les derniers jours du groupe

Avant de risquer quoi que ce soit, regarde ce que le bot *aurait* fait sur les jours passés. Ferme le bot et laisse MT5 ouvert :

```
python -m bot.backtest --days 5                # avec l'analyse IA (≈ 0,08 $ par signal)
python -m bot.backtest --days 5 --no-analyst   # sans le filtre IA, quasi gratuit
```

Le script télécharge les messages du groupe et les bougies de l'or chez ton broker. Il rejoue ensuite chaque message à son heure : l'IA ne voit que le graphique tel qu'il était à ce moment-là. Le prix avance minute par minute (TP, SL, BE, trailing, consignes du groupe). Le rapport est écrit dans `data/backtest/` : résumé, liste des trades, raisons des refus et journal complet.

Les réponses de l'IA sont mises en cache. Si tu relances après avoir changé `config.yaml` (risque, `tp_split`, BE…), seuls les nouveaux appels sont payés. `--refresh` re-télécharge les données. `--balance 10000` règle le solde simulé (en $).

## Commandes Telegram (dans tes « Messages enregistrés »)

| Commande | Effet |
|---|---|
| `/status` | solde, P&L du jour, risque ouvert, trades en cours |
| `/pause` | plus de nouveaux trades (ceux qui sont ouverts restent gérés) |
| `/resume` | reprend |
| `/closeall` | ferme tous les trades du bot |

## Réglages importants (`config.yaml`)

| Réglage | Défaut | Rôle |
|---|---|---|
| `risk.risk_per_trade_pct` | 1.0 | % du solde perdu si le SL est touché |
| `risk.max_daily_loss_pct` | 3.0 | arrêt des nouveaux trades au-delà de cette perte du jour |
| `risk.max_spread` | 0.60 $ | pas d'entrée si le spread est plus large (news, ouverture) |
| `risk.max_entry_drift` | 2.0 $ | écart toléré avec le prix du signal avant de passer en ordre limite |
| `management.tp_split` | 50/30/20 | répartition du lot entre TP1, TP2 et TP3 |
| `management.breakeven_after_tp` | 1 | passage au BE après TP1 |
| `management.trail_to_previous_tp` | true | après TP2, SL sur TP1, etc. |
| `ai.analyst_mode` | filter | `filter` : l'IA peut refuser ou réduire ; `advisory` : avis seulement ; `off` |

Le bot ne touche **qu'à ses propres ordres** (identifiés par `mt5.magic`). Tes trades manuels ne sont pas concernés.

## Coûts

- VPS Windows : 15 à 30 €/mois.
- Claude : moins de 1 $/mois pour lire les messages (Haiku). Environ 0,05 à 0,10 $ par signal pour l'analyse (Opus). Comptez quelques euros par mois.
- Telegram et MT5 : gratuits.

## Tests

```
pip install pytest
python -m pytest -q
```

Les tests rejouent des scénarios complets (signal → 3 positions → TP1 → BE → TP2 → trailing → sortie, consignes du groupe, doublons, refus de l'IA, limites de risque) sur un broker simulé, sans réseau.

## Fichiers

```
bot/main.py        démarrage : Telegram + MT5 + Claude, commandes /status /pause…
bot/engine.py      décisions, exécution, gestion BE/trailing, consignes du groupe
bot/risk.py        règles de risque et calcul des lots (pur, testé)
bot/ai.py          prompts et appels à Claude (lecture des messages, analyse du graphique)
bot/indicators.py  EMA, RSI, ATR, structure, points hauts/bas
bot/broker.py      MetaTrader 5 + broker simulé
bot/store.py       mémoire SQLite (messages, trades, événements)
bot/list_chats.py  liste tes groupes Telegram et leur ID
```
