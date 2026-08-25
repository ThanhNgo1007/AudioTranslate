const dns = require("node:dns").promises;
const net = require("node:net");

const PROFILE_KEYS = new Set(["protocol", "baseUrl", "apiKey", "model"]);
const profileSecrets = new WeakMap();

function cloneAndFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = cloneAndFreeze(child);
  return Object.freeze(result);
}

function assertIdentifier(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

function parseIpv4(address) {
  if (net.isIP(address) !== 4) return null;
  return address.split(".").map((part) => Number.parseInt(part, 10));
}

function expandIpv6(address) {
  let value = String(address).toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIP(value) !== 6) return null;

  const ipv4Match = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (ipv4Match) {
    const bytes = parseIpv4(ipv4Match[2]);
    if (!bytes) return null;
    value = `${ipv4Match[1]}${((bytes[0] << 8) | bytes[1]).toString(16)}:${(
      (bytes[2] << 8) |
      bytes[3]
    ).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (parts.length !== 8) return null;
  return parts.map((part) => Number.parseInt(part || "0", 16));
}

function isPrivateOrSpecialIp(address) {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return Boolean(
      a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0 && c === 0) ||
        (a === 192 && b === 0 && c === 2) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224
    );
  }

  const ipv6 = expandIpv6(address);
  if (!ipv6) return false;
  const [first, second] = ipv6;
  const allZero = ipv6.every((part) => part === 0);
  const loopback = ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1;
  const uniqueLocal = (first & 0xfe00) === 0xfc00;
  const linkLocal = (first & 0xffc0) === 0xfe80;
  const multicast = (first & 0xff00) === 0xff00;
  const documentation = first === 0x2001 && second === 0x0db8;
  const ipv4Mapped = ipv6.slice(0, 5).every((part) => part === 0) && ipv6[5] === 0xffff;
  const ipv4Compatible = ipv6.slice(0, 6).every((part) => part === 0);
  if (ipv4Mapped || ipv4Compatible) {
    const embedded = [ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff];
    if (isPrivateOrSpecialIp(embedded.join("."))) return true;
  }
  return allZero || loopback || uniqueLocal || linkLocal || multicast || documentation;
}

function isLocalHostname(hostname) {
  const normalized = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "host.docker.internal"
  );
}

function normalizeBaseUrl(rawValue, endpointRules = {}, options = {}) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    if (endpointRules.required) throw new Error("Provider baseUrl is required");
    return null;
  }
  if (raw.length > 2048) throw new Error("Provider baseUrl is too long");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Provider baseUrl must be an absolute URL");
  }
  if (url.username || url.password) {
    throw new Error("Provider baseUrl must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Provider baseUrl must not contain a query string or fragment");
  }

  const allowedSchemes = endpointRules.schemes || ["https:", "wss:"];
  if (!allowedSchemes.includes(url.protocol)) {
    throw new Error(`Provider baseUrl must use one of: ${allowedSchemes.join(", ")}`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !options.allowPrivateEndpoint &&
    (isLocalHostname(hostname) || (net.isIP(hostname) && isPrivateOrSpecialIp(hostname)))
  ) {
    throw new Error("Provider baseUrl resolves to a private or special-use address");
  }
  return url.toString();
}

async function assertEndpointResolutionAllowed(baseUrl, options = {}) {
  if (options.allowPrivateEndpoint) return;
  const url = new URL(baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (isPrivateOrSpecialIp(hostname)) {
      throw new Error("Provider endpoint uses a private or special-use address");
    }
    return;
  }

  const lookup = options.lookup || dns.lookup;
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("Provider endpoint did not resolve to an address");
  }
  if (
    records.some(
      (record) =>
        !record || net.isIP(record.address) === 0 || isPrivateOrSpecialIp(record.address),
    )
  ) {
    throw new Error("Provider endpoint resolves to a private or special-use address");
  }
}

function normalizeModel(rawValue, required) {
  const model = String(rawValue || "").trim();
  if (!model) {
    if (required) throw new Error("Provider model is required");
    return null;
  }
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error("Invalid provider model");
  }
  return model;
}

function validateDefinition(rawDefinition) {
  if (!rawDefinition || typeof rawDefinition !== "object") {
    throw new Error("Provider adapter definition must be an object");
  }
  const id = assertIdentifier(rawDefinition.id, "provider id");
  const protocol = assertIdentifier(rawDefinition.protocol, "provider protocol");
  if (typeof rawDefinition.create !== "function") {
    throw new Error(`Provider adapter ${id} must define create()`);
  }
  const capabilities = cloneAndFreeze(rawDefinition.capabilities || {});
  const connection = cloneAndFreeze({
    baseUrl: rawDefinition.connection?.baseUrl || { required: false, schemes: [] },
    apiKey: rawDefinition.connection?.apiKey || { required: false },
    model: rawDefinition.connection?.model || { required: false },
  });
  return Object.freeze({ id, protocol, capabilities, connection, create: rawDefinition.create });
}

function createProviderProfile(definition, rawProfile = {}, options = {}) {
  if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
    throw new Error("Provider profile must be an object");
  }
  for (const key of Object.keys(rawProfile)) {
    if (!PROFILE_KEYS.has(key)) throw new Error(`Unknown provider profile field: ${key}`);
  }
  if (rawProfile.protocol !== definition.protocol) {
    throw new Error(
      `Provider ${definition.id} requires protocol ${definition.protocol}; protocol is not inferred from baseUrl`,
    );
  }
  if (options.purpose === "live-audio" && definition.capabilities.streamingAudioInput !== true) {
    throw new Error(`Provider ${definition.id} does not declare streaming audio input support`);
  }

  const baseUrl = normalizeBaseUrl(rawProfile.baseUrl, definition.connection.baseUrl, options);
  const model = normalizeModel(rawProfile.model, definition.connection.model.required);
  const apiKey = String(rawProfile.apiKey || "");
  if (apiKey.length > 16384 || /[\u0000\r\n]/.test(apiKey)) {
    throw new Error("Invalid provider API key");
  }
  if (definition.connection.apiKey.required && !apiKey) {
    throw new Error("Provider API key is required");
  }

  const profile = Object.freeze({
    provider: definition.id,
    protocol: definition.protocol,
    baseUrl,
    model,
    capabilities: definition.capabilities,
  });
  profileSecrets.set(profile, Object.freeze({ apiKey }));
  return profile;
}

function getProviderApiKey(profile) {
  return profileSecrets.get(profile)?.apiKey || "";
}

class ProviderRegistry {
  constructor(definitions = []) {
    this.definitions = new Map();
    for (const definition of definitions) this.register(definition);
  }

  register(rawDefinition) {
    const definition = validateDefinition(rawDefinition);
    if (this.definitions.has(definition.id)) {
      throw new Error(`Provider adapter already registered: ${definition.id}`);
    }
    this.definitions.set(definition.id, definition);
    return definition;
  }

  get(id) {
    const normalized = assertIdentifier(id, "provider id");
    const definition = this.definitions.get(normalized);
    if (!definition) throw new Error(`Unsupported provider adapter: ${normalized}`);
    return definition;
  }

  list() {
    return [...this.definitions.values()].map(({ create: _create, ...definition }) => definition);
  }

  createProfile(id, rawProfile, options) {
    return createProviderProfile(this.get(id), rawProfile, options);
  }

  create(id, profile, runtimeOptions) {
    const definition = this.get(id);
    if (!profileSecrets.has(profile)) {
      throw new Error("Provider profile was not created by this registry contract");
    }
    if (profile.provider !== definition.id || profile.protocol !== definition.protocol) {
      throw new Error(`Provider profile does not match adapter ${definition.id}`);
    }
    const adapterContext = { profile };
    Object.defineProperty(adapterContext, "apiKey", {
      value: getProviderApiKey(profile),
      enumerable: false,
    });
    return definition.create(adapterContext, runtimeOptions);
  }
}

module.exports = {
  ProviderRegistry,
  assertEndpointResolutionAllowed,
  createProviderProfile,
  getProviderApiKey,
  isLocalHostname,
  isPrivateOrSpecialIp,
  normalizeBaseUrl,
  validateDefinition,
};
