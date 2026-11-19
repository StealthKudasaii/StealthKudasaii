import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import { freshDb } from './helpers';
import { isSetupLocked } from '../src/modules/setup';
import { welcomeChannelId } from '../src/modules/welcome';
import { setResource } from '../src/core/resources';
import { getSetting, setSetting } from '../src/core/settings';
import { __setClientForTests } from '../src/bot/client';

beforeEach(() => freshDb());

test('/setup verrouillé automatiquement dès que le serveur a été installé', () => {
  assert.equal(isSetupLocked(), false, 'serveur neuf : installation possible');
  setResource('role:founder', 'role', '700000000000000001');
  assert.equal(isSetupLocked(), true, 'serveur déjà installé : verrouillé');
  setSetting('setup.locked', false);
  assert.equal(isSetupLocked(), false, 'déverrouillage explicite');
  setSetting('setup.locked', true);
  assert.equal(isSetupLocked(), true);
});

test('bienvenue : salon existant détecté par son nom, ou choisi à la main', () => {
  const ch = (id: string, name: string, type = ChannelType.GuildText) => [id, { id, name, type }] as const;
  __setClientForTests({
    guilds: {
      cache: new Collection([
        [process.env.GUILD_ID!, { id: process.env.GUILD_ID!, channels: { cache: new Collection([ch('1', 'annonces'), ch('1564269903102476399', '👋・bienvenu'), ch('3', 'bienvenue-vocal', ChannelType.GuildVoice)]) } }],
      ]),
    },
  });
  assert.equal(welcomeChannelId(), '1564269903102476399');
  setSetting('channels.overrides', { ...getSetting('channels.overrides'), welcome: '999999999999999999' });
  assert.equal(welcomeChannelId(), '999999999999999999', 'le choix fait avec /salon est prioritaire');
});
