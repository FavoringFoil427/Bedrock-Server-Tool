import {
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  CustomCommandOrigin,
  CustomCommandResult,
  Player,
  system,
} from '@minecraft/server';
import { onChat, chatAvailable } from './chatbridge';
import { cfg } from './config';
import { can } from './permissions';
import { t } from './i18n';
import { err, tell, C } from './util';

/**
 * Command layer.
 *
 * Every command is declared once and exposed two ways:
 *  - a native custom command (`/adm:home`), so it appears in the game's own
 *    command help and autocompletes;
 *  - a chat command (`!home`), which works on any client and supports
 *    free-form trailing text.
 *
 * Handlers always run deferred via `system.run`, because both the custom
 * command callback and `chatSend` fire in a read-only context where world
 * mutation throws.
 */

export type ArgType = 'string' | 'int' | 'float' | 'bool' | 'player';

export interface CommandArg {
  name: string;
  type: ArgType;
  optional?: boolean;
}

export interface CommandContext {
  player: Player;
  /** Positional arguments as raw strings, in declaration order. */
  args: string[];
  /** Everything typed after the command name (chat invocations only). */
  rest: string;
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  category: string;
  permission?: string;
  args?: CommandArg[];
  /** When true the final argument swallows the remaining text. */
  greedy?: boolean;
  handler: (ctx: CommandContext) => void | Promise<void>;
}

const registry = new Map<string, CommandDef>();
const aliasMap = new Map<string, string>();
let startupDone = false;

export function commands(): CommandDef[] {
  return [...registry.values()];
}

export function usageOf(command: CommandDef): string {
  const prefix = cfg().commandPrefix;
  const args = (command.args ?? [])
    .map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`))
    .join(' ');
  return `${prefix}${command.name}${args ? ' ' + args : ''}`;
}

/** Declares a command. Must be called before the startup event fires. */
export function register(command: CommandDef): void {
  registry.set(command.name, command);
  for (const alias of command.aliases ?? []) aliasMap.set(alias, command.name);
  if (startupDone) {
    console.warn(`[AdminSuite] command "${command.name}" registered after startup; chat-only.`);
  }
}

function lookup(name: string): CommandDef | undefined {
  const key = name.toLowerCase();
  return registry.get(key) ?? registry.get(aliasMap.get(key) ?? '');
}

function paramType(type: ArgType): CustomCommandParamType {
  switch (type) {
    case 'int':
      return CustomCommandParamType.Integer;
    case 'float':
      return CustomCommandParamType.Float;
    case 'bool':
      return CustomCommandParamType.Boolean;
    case 'player':
      return CustomCommandParamType.PlayerSelector;
    default:
      return CustomCommandParamType.String;
  }
}

/** Normalises a native argument into the string form handlers expect. */
function nativeArgToString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    // PlayerSelector resolves to an array of entities.
    const first = value[0] as { name?: string } | undefined;
    return first?.name ?? '';
  }
  if (typeof value === 'object' && 'name' in (value as object)) {
    return String((value as { name: unknown }).name ?? '');
  }
  return String(value);
}

function dispatch(command: CommandDef, player: Player, args: string[], rest: string): void {
  if (command.permission && !can(player, command.permission)) {
    err(player, t('err.noPermission'));
    return;
  }
  const required = (command.args ?? []).filter((a) => !a.optional).length;
  if (args.filter((a) => a.length > 0).length < required) {
    err(player, t('err.usage', { usage: usageOf(command) }));
    return;
  }
  void (async () => {
    try {
      await command.handler({ player, args, rest });
    } catch (error) {
      console.warn(`[AdminSuite] command "${command.name}" failed: ${error}`);
      err(player, 'That command failed. Check the content log for details.');
    }
  })();
}

/** Registers every declared command with the engine's custom command registry. */
export function installNativeCommands(): void {
  system.beforeEvents.startup.subscribe((event) => {
    const cmdRegistry = event.customCommandRegistry;
    for (const command of registry.values()) {
      const args = command.args ?? [];
      const mandatory = args.filter((a) => !a.optional).map((a) => ({ name: a.name, type: paramType(a.type) }));
      const optional = args.filter((a) => a.optional).map((a) => ({ name: a.name, type: paramType(a.type) }));
      try {
        cmdRegistry.registerCommand(
          {
            name: `adm:${command.name}`,
            description: command.description,
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            ...(mandatory.length ? { mandatoryParameters: mandatory } : {}),
            ...(optional.length ? { optionalParameters: optional } : {}),
          },
          (origin: CustomCommandOrigin, ...values: unknown[]): CustomCommandResult => {
            const source = origin.sourceEntity;
            if (!(source instanceof Player)) {
              return { status: CustomCommandStatus.Failure, message: 'Players only.' };
            }
            const player = source;
            const strings = values.map(nativeArgToString);
            // Custom command callbacks are read-only; defer the real work.
            system.run(() => dispatch(command, player, strings, strings.join(' ')));
            return { status: CustomCommandStatus.Success };
          },
        );
      } catch (error) {
        console.warn(`[AdminSuite] could not register /adm:${command.name}: ${error}`);
      }
    }
    startupDone = true;
  });
}

/** Splits a chat command line, honouring "quoted arguments". */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : match[2]);
  }
  return tokens;
}

/** Hooks chat so `!command` lines are intercepted before they reach chat. */
export function installChatCommands(): void {
  onChat((event) => {
    const prefix = cfg().commandPrefix;
    const message = event.message;
    if (!prefix || !message.startsWith(prefix)) return;

    // Must be set synchronously, before the event completes.
    event.cancel = true;

    const player = event.sender;
    const line = message.slice(prefix.length).trim();
    const tokens = tokenize(line);
    const name = tokens.shift() ?? '';
    const command = lookup(name);

    system.run(() => {
      if (!command) {
        err(player, t('err.unknownCommand', { prefix }));
        return;
      }
      const spec = command.args ?? [];
      let args = tokens;
      if (command.greedy && spec.length > 0 && tokens.length > spec.length) {
        // Collapse the overflow into the final declared argument.
        args = tokens.slice(0, spec.length - 1).concat(tokens.slice(spec.length - 1).join(' '));
      }
      dispatch(command, player, args, tokens.join(' '));
    });
  });
}

/** True when `!command` style input is usable in this world. */
export function chatCommandsEnabled(): boolean {
  return chatAvailable();
}

/** Sends the grouped command list (`!info`). */
export function sendCommandList(player: Player): void {
  const prefix = cfg().commandPrefix;
  const groups = new Map<string, CommandDef[]>();
  for (const command of registry.values()) {
    if (command.permission && !can(player, command.permission)) continue;
    const list = groups.get(command.category) ?? [];
    list.push(command);
    groups.set(command.category, list);
  }

  tell(player, `${C.title}Available commands`);
  player.sendMessage(
    chatAvailable()
      ? `${C.dim}Chat prefix "${prefix}" - native form "/adm:<command>"`
      : `${C.dim}Use "/adm:<command>" (chat prefix needs Beta APIs enabled)`,
  );
  for (const [category, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    player.sendMessage(`${C.gold}${category}`);
    for (const command of list.sort((a, b) => a.name.localeCompare(b.name))) {
      player.sendMessage(`  ${C.accent}${usageOf(command)} ${C.dim}- ${command.description}`);
    }
  }
}
