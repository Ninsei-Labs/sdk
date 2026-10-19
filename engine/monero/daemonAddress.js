// WHERE A MONERO NODE MAY LIVE: ONE POLICY FOR EVERY CLIENT.
//
// WHY. An open `http://` connection to a machine across the network shows anyone on the path what is asked and what
// is answered: addresses, amounts, transfer ids. A node refuses that on mainnet, and the sweep page - which lets an
// operator type their own node address - accepts it today. Two answers to one question is how one of them ends up
// allowing exactly what the other forbids.
//
// THE RULE. `https` anywhere; `http` on loopback (where the kernel, not the network, answers for the wire); `http`
// to a remote host only on stagenet and testnet, where the public nodes known to us serve http only. Everything
// else is refused with a code, and an unknown network is judged as mainnet: a network we cannot name cannot be
// judged safe.
//
// LOOPBACK IS THREE NAMES, NOT ALL OF 127.0.0.0/8. That is how the node already counted, and widening the concept
// under the cover of a fix would change behaviour nobody measured.
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || "").toLowerCase());
}

/** ADDRESS -> { scheme, host }, or null when the text is not a URL. A port and a path are allowed and ignored. */
export function hostOfUrl(url) {
  try {
    const u = new URL(String(url));
    const scheme = String(u.protocol || "").replace(":", "").toLowerCase();
    const host = String(u.hostname || "").replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    return { scheme, host };
  } catch { return null; }
}

export const DAEMON_CODES = Object.freeze({
  notHttps: "daemon-not-https",
  unreadable: "daemon-address-unreadable",
  schemeUnknown: "daemon-scheme-unknown",
});

/** The networks where a remote plain-http daemon is accepted. Every other name, including an unknown one, is not. */
export const DAEMON_PLAIN_HTTP_NETWORKS = Object.freeze(["stagenet", "testnet"]);
export const DAEMON_NETWORK_MAINNET = "mainnet";

/**
 * A SETTING READ IN ONE SHAPE: switching off is a named 0/false/no/off; anything else, a typo included, leaves the
 * exception ON, because the safe default here is "loopback allowed, outside not".
 */
export function plainLoopbackAllowed(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

/**
 * THE DECISION FOR ONE ADDRESS.
 *
 * `ok` - may this address be used. `configured: false` for an empty value (nothing to judge, not a refusal).
 * `code` names a refusal; `reason` is a short technical phrase for the caller's log, not interface text.
 */
export function judgeDaemonAddress(raw, { network = DAEMON_NETWORK_MAINNET, allowPlainLoopback = true } = {}) {
  const value = String(raw == null ? "" : raw).trim();
  const allowed = allowPlainLoopback === undefined || allowPlainLoopback === null ? true : Boolean(allowPlainLoopback);
  const net = String(network == null ? "" : network).trim().toLowerCase() || DAEMON_NETWORK_MAINNET;
  const base = { configured: Boolean(value), scheme: null, host: null, loopback: false, plainLoopbackAllowed: allowed, plainHttpAccepted: false, network: net };
  if (!value) return { ...base, ok: true, code: null, reason: null };
  const target = hostOfUrl(value);
  if (!target) return { ...base, ok: false, code: DAEMON_CODES.unreadable, reason: "not a URL" };
  // "node.example:18081" parses as a URL whose scheme is "node.example" and whose host is empty - a missing
  // scheme, not a foreign one. A daemon address without a host is unreadable either way.
  if (!target.host) return { ...base, ok: false, scheme: target.scheme || null, code: DAEMON_CODES.unreadable, reason: "no host in the address" };
  const loopback = isLoopbackHost(target.host);
  if (target.scheme !== "http" && target.scheme !== "https") {
    return { ...base, scheme: target.scheme, host: target.host, loopback, ok: false, code: DAEMON_CODES.schemeUnknown, reason: "scheme " + JSON.stringify(target.scheme) + " is neither http nor https" };
  }
  const seen = { ...base, scheme: target.scheme, host: target.host, loopback };
  if (target.scheme === "https") return { ...seen, ok: true, code: null, reason: null };
  if (loopback) {
    return allowed
      ? { ...seen, ok: true, code: null, reason: null }
      : { ...seen, ok: false, code: DAEMON_CODES.notHttps, reason: "plain http on loopback, and the loopback exception is switched off" };
  }
  if (DAEMON_PLAIN_HTTP_NETWORKS.includes(net)) {
    return { ...seen, ok: true, plainHttpAccepted: true, code: null, reason: null };
  }
  return { ...seen, ok: false, code: DAEMON_CODES.notHttps, reason: "plain http to a remote host on " + net };
}
