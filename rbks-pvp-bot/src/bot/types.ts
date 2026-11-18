import type {
  AutocompleteInteraction,
  AnySelectMenuInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Feature } from '../core/permissions';

export interface SlashCommand {
  data: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody; name: string };
  /** Permission requise pour toute la commande (sinon vérifiée dans execute, par sous-commande). */
  feature?: Feature;
  /** Catégorie affichée dans /help. */
  category: string;
  /** Description courte pour /help, par sous-commande si nécessaire. */
  help: { usage: string; description: string; feature?: Feature }[];
  execute(i: ChatInputCommandInteraction<'cached'>): Promise<unknown>;
  autocomplete?(i: AutocompleteInteraction<'cached'>): Promise<unknown>;
}

export type ComponentInteraction = ButtonInteraction<'cached'> | AnySelectMenuInteraction<'cached'> | ModalSubmitInteraction<'cached'>;

/**
 * Gestionnaire de composants persistant. customId = `prefixe:action:arg1:arg2...`.
 * Les customIds ne dépendent que de la base de données : les boutons restent fonctionnels après un redémarrage.
 */
export interface ComponentHandler {
  prefix: string;
  handle(i: ComponentInteraction, action: string, args: string[]): Promise<unknown>;
}

export interface BotModule {
  name: string;
  commands?: SlashCommand[];
  components?: ComponentHandler[];
}

export type AnyButton = ButtonInteraction<'cached'>;

export function cid(prefix: string, action: string, ...args: (string | number)[]): string {
  const id = [prefix, action, ...args].join(':');
  if (id.length > 100) throw new Error(`customId trop long : ${id}`);
  return id;
}
