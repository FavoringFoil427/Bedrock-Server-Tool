import { Player } from '@minecraft/server';
import {
  ActionFormData,
  ActionFormResponse,
  FormCancelationReason,
  MessageFormData,
  ModalFormData,
  ModalFormResponse,
} from '@minecraft/server-ui';
import { sleep, C } from './util';
import { sfx } from './sound';

/**
 * Form helpers.
 *
 * A form cannot open while the player has a screen (chat, pause menu) in the
 * way; the API reports that as `UserBusy`. Every helper retries for a few
 * seconds so a menu opened from a chat command still appears.
 */

const BUSY_RETRIES = 40;
const BUSY_DELAY_TICKS = 5;

async function showWithRetry<T extends { canceled: boolean; cancelationReason?: FormCancelationReason }>(
  show: () => Promise<T>,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < BUSY_RETRIES; attempt++) {
    const response = await show();
    if (!response.canceled) return response;
    if (response.cancelationReason !== FormCancelationReason.UserBusy) return undefined;
    await sleep(BUSY_DELAY_TICKS);
  }
  return undefined;
}

export interface MenuButton {
  text: string;
  icon?: string;
  onClick: () => void | Promise<void>;
}

export interface MenuOptions {
  title: string;
  body?: string;
  buttons: MenuButton[];
  /** Rendered as a trailing "Back" button when provided. */
  back?: () => void | Promise<void>;
}

/** Opens a button menu and dispatches the chosen action. */
export async function menu(player: Player, options: MenuOptions): Promise<void> {
  const form = new ActionFormData().title(options.title);
  if (options.body) form.body(options.body);

  const buttons = [...options.buttons];
  if (options.back) buttons.push({ text: `${C.dim}Back`, icon: 'textures/ui/adm_back', onClick: options.back });

  if (buttons.length === 0) {
    form.body((options.body ? options.body + '\n\n' : '') + `${C.dim}Nothing to show.`);
    form.button(`${C.dim}Close`);
    await showWithRetry<ActionFormResponse>(() => form.show(player));
    return;
  }

  for (const button of buttons) {
    if (button.icon) form.button(button.text, button.icon);
    else form.button(button.text);
  }

  sfx(player, 'open');
  const response = await showWithRetry<ActionFormResponse>(() => form.show(player));
  if (!response || response.selection === undefined) return;
  const chosen = buttons[response.selection];
  if (chosen) await chosen.onClick();
}

/** Yes/no dialog. Resolves true only when the player picks confirm. */
export async function confirm(
  player: Player,
  title: string,
  body: string,
  confirmText = `${C.bad}Confirm`,
  cancelText = `${C.dim}Cancel`,
): Promise<boolean> {
  const form = new MessageFormData().title(title).body(body).button1(cancelText).button2(confirmText);
  const response = await showWithRetry(() => form.show(player));
  // button2 is the right-hand (confirm) button, reported as selection 1.
  return response?.selection === 1;
}

/** Field descriptors for {@link prompt}. */
export type Field =
  | { kind: 'text'; label: string; placeholder?: string; default?: string }
  | { kind: 'toggle'; label: string; default?: boolean }
  | { kind: 'slider'; label: string; min: number; max: number; step?: number; default?: number }
  | { kind: 'dropdown'; label: string; options: string[]; default?: number };

export type FieldValues = (string | boolean | number)[];

/**
 * Opens a modal form built from `fields` and returns the submitted values in
 * order, or `undefined` when the player dismissed it.
 */
export async function prompt(
  player: Player,
  title: string,
  fields: Field[],
  submitText = 'Submit',
): Promise<FieldValues | undefined> {
  const form = new ModalFormData().title(title);
  for (const field of fields) {
    switch (field.kind) {
      case 'text':
        form.textField(field.label, field.placeholder ?? '', { defaultValue: field.default ?? '' });
        break;
      case 'toggle':
        form.toggle(field.label, { defaultValue: field.default ?? false });
        break;
      case 'slider':
        form.slider(field.label, field.min, field.max, {
          valueStep: field.step ?? 1,
          defaultValue: field.default ?? field.min,
        });
        break;
      case 'dropdown':
        form.dropdown(field.label, field.options, { defaultValueIndex: field.default ?? 0 });
        break;
    }
  }
  form.submitButton(submitText);

  const response = await showWithRetry<ModalFormResponse>(() => form.show(player));
  if (!response || !response.formValues) return undefined;
  return response.formValues.map((value, index) => {
    if (value !== undefined) return value;
    const field = fields[index];
    if (field.kind === 'toggle') return field.default ?? false;
    if (field.kind === 'slider') return field.default ?? field.min;
    if (field.kind === 'dropdown') return field.default ?? 0;
    return field.default ?? '';
  });
}

/** Convenience wrapper for a single free-text question. */
export async function askText(
  player: Player,
  title: string,
  label: string,
  placeholder = '',
  initial = '',
): Promise<string | undefined> {
  const values = await prompt(player, title, [
    { kind: 'text', label, placeholder, default: initial },
  ]);
  if (!values) return undefined;
  const text = String(values[0] ?? '').trim();
  return text.length > 0 ? text : undefined;
}

const PAGE_SIZE = 20;

export interface PagedOptions<T> {
  title: string;
  body?: string;
  items: T[];
  render: (item: T) => { text: string; icon?: string };
  onPick: (item: T) => void | Promise<void>;
  back?: () => void | Promise<void>;
  page?: number;
  /** Buttons pinned above the list, shown on the first page only. */
  actions?: MenuButton[];
  /** Shown in place of the list when there is nothing to list. */
  empty?: string;
  /**
   * Makes the list searchable. Lists that grow with the server - players,
   * bans, listings - are unusable by paging alone once they are long.
   */
  search?: { label?: string; match: (item: T, needle: string) => boolean };
  /** Active search text. Set by the search button, not by callers. */
  query?: string;
}

/**
 * Renders a long list across pages. Bedrock forms slow down badly past a few
 * dozen buttons, so lists are chunked with next/previous controls.
 */
export async function paged<T>(player: Player, options: PagedOptions<T>): Promise<void> {
  const query = options.query ?? '';
  const needle = query.trim().toLowerCase();
  const items = options.search && needle
    ? options.items.filter((item) => options.search!.match(item, needle))
    : options.items;

  const page = options.page ?? 0;
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const slice = items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  const buttons: MenuButton[] = current === 0 ? [...(options.actions ?? [])] : [];

  // Offered from the first page only, alongside any actions the screen adds.
  if (options.search && current === 0) {
    buttons.push({
      text: query ? `${C.warn}Showing "${query}" - show all` : `${C.accent}Search`,
      icon: 'textures/ui/adm_explore',
      onClick: async () => {
        if (query) return paged(player, { ...options, query: '', page: 0 });
        const text = await askText(player, 'Search', options.search?.label ?? 'Name contains');
        return paged(player, { ...options, query: text ?? '', page: 0 });
      },
    });
  }
  for (const item of slice) {
    const rendered = options.render(item);
    buttons.push({
      text: rendered.text,
      ...(rendered.icon ? { icon: rendered.icon } : {}),
      onClick: () => options.onPick(item),
    });
  }

  if (current > 0) {
    buttons.push({
      text: `${C.dim}<- Previous page`,
      onClick: () => paged(player, { ...options, page: current - 1 }),
    });
  }
  if (current < pages - 1) {
    buttons.push({
      text: `${C.dim}Next page ->`,
      onClick: () => paged(player, { ...options, page: current + 1 }),
    });
  }

  const header = pages > 1 ? `${C.dim}Page ${current + 1}/${pages}` : '';
  // An empty list otherwise renders as a form with nothing but a Back button,
  // which reads as broken rather than empty. A search that matched nothing
  // needs saying too, or it looks like the list itself emptied.
  const empty = items.length > 0 ? ''
    : needle ? `${C.dim}Nothing matches "${query}".`
    : (options.empty ?? '');
  const body = [options.body, empty, header].filter(Boolean).join('\n');

  await menu(player, {
    title: options.title,
    ...(body ? { body } : {}),
    buttons,
    ...(options.back ? { back: options.back } : {}),
  });
}
