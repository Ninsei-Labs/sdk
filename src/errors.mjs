// SDK ERRORS: a code plus params, with no human-facing text.
//
// message is deliberately equal to the code: it is read by logs and tests. The interface must do the
// showing, taking the code and params - otherwise the wording would end up in the core, with nowhere left
// to translate it.

export class SdkError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.name = "SdkError";
    this.code = code;
    this.params = params;
  }
  toJSON() {
    return { code: this.code, params: this.params };
  }
}

export const fail = (code, params) => {
  throw new SdkError(code, params);
};

// Refusal as a value: part of the SDK returns a refusal state instead of throwing (the quote snapshot, a guard verdict).
export const refusal = (code, params = {}) => ({ ok: false, error: { code, params } });
