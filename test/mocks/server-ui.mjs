/** Minimal stand-in for @minecraft/server-ui. */
export const FormCancelationReason = { UserBusy: 'UserBusy', UserClosed: 'UserClosed' };

class Base {
  constructor() { this.parts = []; }
  title(t) { this.parts.push(['title', t]); return this; }
  body(t) { this.parts.push(['body', t]); return this; }
  async show() { return { canceled: true, cancelationReason: FormCancelationReason.UserClosed }; }
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
