import type { BotModule, ComponentHandler, SlashCommand } from './types';

const commands = new Map<string, SlashCommand>();
const components = new Map<string, ComponentHandler>();
const modules: BotModule[] = [];

export function registerModules(list: BotModule[]): void {
  for (const m of list) {
    modules.push(m);
    for (const c of m.commands ?? []) {
      if (commands.has(c.data.name)) throw new Error(`Commande en double : ${c.data.name}`);
      commands.set(c.data.name, c);
    }
    for (const h of m.components ?? []) {
      if (components.has(h.prefix)) throw new Error(`Préfixe de composant en double : ${h.prefix}`);
      components.set(h.prefix, h);
    }
  }
}

export const getCommand = (name: string) => commands.get(name);
export const getComponentHandler = (prefix: string) => components.get(prefix);
export const allCommands = () => [...commands.values()];
export const allModules = () => modules;
