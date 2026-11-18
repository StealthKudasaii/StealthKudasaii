import {
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  type ActionRowBuilder,
  type ButtonBuilder,
  type InteractionReplyOptions,
  type RepliableInteraction,
} from 'discord.js';
import { errorEmbed, successEmbed } from './ui/embeds';
import { can, type Feature } from '../core/permissions';

type Payload = string | EmbedBuilder | { embeds?: EmbedBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[] | any[]; content?: string; files?: any[] };

function toOptions(p: Payload): InteractionReplyOptions {
  if (typeof p === 'string') return { embeds: [successEmbed(p)] };
  if (p instanceof EmbedBuilder) return { embeds: [p] };
  return p as InteractionReplyOptions;
}

/** Réponse privée qui fonctionne que l'interaction ait déjà été répondue/différée ou non. */
export async function ephemeral(i: RepliableInteraction, payload: Payload): Promise<void> {
  const opts = toOptions(payload);
  try {
    if (i.deferred && !i.replied) await i.editReply(opts as any);
    else if (i.replied) await i.followUp({ ...opts, flags: MessageFlags.Ephemeral } as any);
    else await i.reply({ ...opts, flags: MessageFlags.Ephemeral } as any);
  } catch (e) {
    if (!isExpiredInteraction(e)) throw e;
  }
}

export async function fail(i: RepliableInteraction, message: string): Promise<void> {
  await ephemeral(i, errorEmbed(message));
}

/** Vérifie une permission fonctionnelle et répond un refus propre sinon. */
export async function requireFeature(i: RepliableInteraction, feature: Feature, extraRoleIds: string[] = []): Promise<boolean> {
  const member = i.inCachedGuild() ? i.member : null;
  if (can(member, feature, extraRoleIds)) return true;
  await fail(i, 'Tu n’as pas la permission d’effectuer cette action.');
  return false;
}

export async function deferEphemeral(i: RepliableInteraction): Promise<void> {
  if (!i.deferred && !i.replied) await i.deferReply({ flags: MessageFlags.Ephemeral });
}

/** Erreurs Discord liées à une interaction expirée (> 3 s sans réponse, ou déjà acquittée). */
export function isExpiredInteraction(e: unknown): boolean {
  return e instanceof DiscordAPIError && (e.code === 10062 || e.code === 40060 || e.code === 10015);
}

export function isUnknownResource(e: unknown): boolean {
  return e instanceof DiscordAPIError && [10003, 10004, 10007, 10008, 10011, 10013].includes(Number(e.code));
}

export function isMissingPermissions(e: unknown): boolean {
  return e instanceof DiscordAPIError && (e.code === 50013 || e.code === 50001);
}

/** Message d'erreur lisible pour une erreur Discord connue. */
export function explainDiscordError(e: unknown): string {
  if (isMissingPermissions(e)) return 'Le bot n’a pas les permissions Discord nécessaires (rôle trop bas ou permission manquante).';
  if (e instanceof DiscordAPIError && e.code === 50007) return 'Impossible d’envoyer un message privé à ce membre (MP fermés).';
  if (isUnknownResource(e)) return 'L’élément Discord concerné n’existe plus.';
  if (e instanceof DiscordAPIError) return `Erreur Discord : ${e.message}`;
  return 'Une erreur inattendue est survenue.';
}

/** Ouvre une modale (impossible depuis une autre modale : Discord l'interdit, on propose alors un bouton). */
export async function openModal(i: RepliableInteraction, modal: import('discord.js').ModalBuilder): Promise<void> {
  if (i.isModalSubmit() || !('showModal' in i)) throw new Error('Une fenêtre ne peut pas être ouverte depuis une autre fenêtre.');
  await (i as import('discord.js').ButtonInteraction).showModal(modal);
}

/** Vrai si l'interaction vient d'un message privé (éphémère) qu'on peut donc remplacer sans risque. */
export function fromEphemeralMessage(i: import('discord.js').Interaction): boolean {
  const msg = 'message' in i ? (i.message as import('discord.js').Message | null) : null;
  return !!msg?.flags?.has(MessageFlags.Ephemeral);
}
