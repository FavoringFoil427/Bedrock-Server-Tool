/** Minimal stand-in for @minecraft/server-ui. */
export const FormCancelationReason = { UserBusy: 'UserBusy', UserClosed: 'UserClosed' };

/**
 * Forms are scriptable so tests can actually click through a menu rather than
 * only inspecting source. Queue responses with `__ui.answer(...)`; anything
 * shown with nothing queued is treated as the player closing the form.
 */
const queued = [];
export const __ui = {
  /** Every form shown since the last reset, in order. */
  shown: [],
  /** Queue one response. A function receives the form and returns a response. */
  answer(response) { queued.push(response); return __ui; },
  /** Pick the button whose label matches, by regex or substring. */
  click(match) {
    return __ui.answer((form) => {
      const index = buttonsOf(form).findIndex((text) => test(match, text));
      if (index < 0) throw new Error(`no button matching ${match} in [${buttonsOf(form).join(' | ')}]`);
      return { canceled: false, selection: index };
    });
  },
  /** Submit a modal form with these field values, in order. */
  submit(...formValues) {
    return __ui.answer({ canceled: false, formValues });
  },
  /**
   * Queues a form that stays open, the way a real one waits on the player.
   * Returns a function that closes it, optionally on a button.
   */
  hold() {
    let settle;
    const waiting = new Promise((resolve) => { settle = resolve; });
    __ui.answer(() => waiting);
    return (selection) => settle(selection === undefined
      ? { canceled: true, cancelationReason: FormCancelationReason.UserClosed }
      : { canceled: false, selection });
  },
  /** Queues a "the player has another screen up" refusal. */
  busy() {
    return __ui.answer({ canceled: true, cancelationReason: FormCancelationReason.UserBusy });
  },
  /** Button labels of the last form shown. */
  lastButtons() { return buttonsOf(__ui.shown[__ui.shown.length - 1]); },
  /** Body text of the last form shown. */
  lastBody() {
    const parts = (__ui.shown[__ui.shown.length - 1]?.parts ?? []).filter((p) => p[0] === 'body');
    return parts.map((p) => p[1]).join('\n');
  },
  reset() { queued.length = 0; __ui.shown.length = 0; },
  pending() { return queued.length; },
};

function test(match, text) {
  return match instanceof RegExp ? match.test(text) : String(text).includes(match);
}

function buttonsOf(form) {
  return (form?.parts ?? []).filter((p) => p[0] === 'button').map((p) => p[1]);
}

class Base {
  constructor() { this.parts = []; }
  title(t) { this.parts.push(['title', t]); return this; }
  body(t) { this.parts.push(['body', t]); return this; }
  async show() {
    __ui.shown.push(this);
    const next = queued.shift();
    if (next === undefined) return { canceled: true, cancelationReason: FormCancelationReason.UserClosed };
    return typeof next === 'function' ? next(this) : next;
  }
}
export class ActionFormData extends Base {
  button(t, i) { this.parts.push(['button', t, i]); return this; }
  header(t) { return this; }
  label(t) { return this; }
  divider() { return this; }
}
export class ModalFormData extends Base {
  textField(...a) { this.parts.push(['text', ...a]); return this; }
  toggle(...a) { this.parts.push(['toggle', ...a]); return this; }
  slider(...a) { this.parts.push(['slider', ...a]); return this; }
  dropdown(...a) { this.parts.push(['dropdown', ...a]); return this; }
  submitButton(t) { return this; }
  header(t) { return this; }
  label(t) { return this; }
  divider() { return this; }
}
export class MessageFormData extends Base {
  button1(t) { this.parts.push(['b1', t]); return this; }
  button2(t) { this.parts.push(['b2', t]); return this; }
}
export class ActionFormResponse {}
export class ModalFormResponse {}
export class MessageFormResponse {}
