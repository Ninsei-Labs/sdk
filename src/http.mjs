// THE SDK TRANSPORT: the API address and the fetch function COME FROM OUTSIDE.
//
// Why not a global fetch: the interface lives in different environments (browser, SSR, tests, later a mobile
// app), and requiring a global fetch of it would mean dictating its environment. Besides, the timeout and the
// response parsing must live in one place rather than in every call: otherwise one call forgets the timeout and
// another forgets the status-code check, and a network refusal looks like an empty market.
import { SdkError } from "./errors.mjs";

const defaultFetch = () => (typeof fetch === "function" ? fetch : null);

export function createHttp({ apiBase, fetchImpl = null, timeoutMs = 20_000 }) {
  const impl = fetchImpl || defaultFetch();
  return {
    /** The response as data. A network refusal and a non-2xx are a code, not a transport exception. */
    // METHOD, HEADERS AND BODY ARE PASSED FROM OUTSIDE: without that a POST with a body would silently leave as
    // a GET, and the service would answer with a refusal to a request it did not understand. The defaults are
    // the previous ones (GET without a body).
    async json(path, { signal = null, method = "GET", headers = null, body = null } = {}) {
      if (typeof impl !== "function") throw new SdkError("bad-input", { field: "fetch" });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const abort = () => ctrl.abort();
      if (signal) signal.addEventListener("abort", abort, { once: true });
      try {
                const init = { signal: ctrl.signal, method, headers: { accept: "application/json", ...(headers || {}) } };
        if (body !== null && body !== undefined) init.body = body;
        const res = await impl(apiBase + path, init);
        if (!res || typeof res.ok !== "boolean") throw new SdkError("server-unavailable", { why: "bad-response" });
        if (!res.ok) throw new SdkError("server-unavailable", { status: res.status });
        return await res.json();
      } catch (error) {
        if (error instanceof SdkError) throw error;
        throw new SdkError("server-unavailable", { why: error && error.name === "AbortError" ? "timeout" : "fetch" });
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", abort);
      }
    },
    /**
     * THE SAME AS `json`, BUT THE SERVICE'S REFUSAL IS RETURNED AS A VALUE: { ok, status, body }.
     *
     * Why a separate method. `json` throws server-unavailable {status} and LOSES the response body, while the
     * body carries the service's reason (our app answers {ok:false,error:"..."}). For the "server" step the
     * reason is needed in full: without it a 403 "the escrow belongs to another wallet" is indistinguishable
     * from a 400 "an escrow address is required", and the interface gets "something went wrong" instead of an
     * answer to its question. A connection error is still thrown as a code: "did not answer" and "answered and
     * refused" are different things, and the caller must see them.
     */
    async tryJson(path, { signal = null, method = "GET", headers = null, body = null } = {}) {
      if (typeof impl !== "function") throw new SdkError("bad-input", { field: "fetch" });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const abort = () => ctrl.abort();
      if (signal) signal.addEventListener("abort", abort, { once: true });
      try {
        const init = { signal: ctrl.signal, method, headers: { accept: "application/json", ...(headers || {}) } };
        if (body !== null && body !== undefined) init.body = body;
        const res = await impl(apiBase + path, init);
        if (!res || typeof res.ok !== "boolean") throw new SdkError("server-unavailable", { why: "bad-response" });
        let parsed = null;
        try { parsed = await res.json(); } catch { parsed = null; }
        return { ok: res.ok, status: res.status, body: parsed };
      } catch (error) {
        if (error instanceof SdkError) throw error;
        throw new SdkError("server-unavailable", { why: error && error.name === "AbortError" ? "timeout" : "fetch" });
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", abort);
      }
    },
  };
}
