import { EmbedBuilder, type ColorResolvable } from 'discord.js';
import { COLORS } from '../../config/constants';
import { brandColor, getSetting } from '../../core/settings';
import { truncate } from '../../core/text';

/** Embed à l'identité RBKS PVP : couleur, pied de page et logo cohérents partout. */
export function brandEmbed(opts: { title?: string; description?: string; color?: number; timestamp?: boolean; footerExtra?: string } = {}): EmbedBuilder {
  const e = new EmbedBuilder().setColor((opts.color ?? brandColor()) as ColorResolvable);
  if (opts.title) e.setTitle(truncate(opts.title, 256));
  if (opts.description) e.setDescription(truncate(opts.description, 4096));
  const footer = getSetting('brand.footer');
  const logo = getSetting('brand.logoUrl');
  const text = [footer, opts.footerExtra].filter(Boolean).join(' • ');
  if (text) e.setFooter({ text: truncate(text, 2048), ...(logo ? { iconURL: logo } : {}) });
  if (opts.timestamp !== false) e.setTimestamp();
  return e;
}

function simple(color: number, icon: string) {
  return (message: string, title?: string) =>
    new EmbedBuilder()
      .setColor(color)
      .setDescription(truncate(`${icon} ${title ? `**${title}**\n` : ''}${message}`, 4096));
}

export const successEmbed = simple(COLORS.success, '✅');
export const errorEmbed = simple(COLORS.danger, '⛔');
export const warnEmbed = simple(COLORS.warning, '⚠️');
export const infoEmbed = simple(COLORS.info, 'ℹ️');

/** Ajoute un champ en respectant les limites Discord (nom 256, valeur 1024, 25 champs). */
export function safeField(e: EmbedBuilder, name: string, value: string, inline = false): EmbedBuilder {
  if ((e.data.fields?.length ?? 0) >= 25) return e;
  return e.addFields({ name: truncate(name || '​', 256), value: truncate(value || '—', 1024), inline });
}

/** Taille totale d'un embed (Discord limite à 6000 caractères par message). */
export function embedLength(e: EmbedBuilder): number {
  const d = e.data;
  return (
    (d.title?.length ?? 0) +
    (d.description?.length ?? 0) +
    (d.footer?.text.length ?? 0) +
    (d.author?.name.length ?? 0) +
    (d.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}
