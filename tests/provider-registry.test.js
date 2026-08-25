const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ProviderRegistry,
  assertEndpointResolutionAllowed,
  getProviderApiKey,
  isPrivateOrSpecialIp,
} = require("../src/provider-registry");

function realtimeDefinition(overrides = {}) {
  return {
    id: "vendor-live",
    protocol: "vendor-realtime-v1",
    capabilities: {
      streamingAudioInput: true,
      partialCaptions: true,
    },
    connection: {
      baseUrl: { required: true, schemes: ["wss:"] },
      apiKey: { required: true },
      model: { required: true },
    },
    create: ({ profile, apiKey }) => ({ profile, apiKey }),
    ...overrides,
  };
}

test("registry requires an exact protocol and declared live-audio capability", () => {
  const registry = new ProviderRegistry([realtimeDefinition()]);
  assert.throws(
    () =>
      registry.createProfile(
        "vendor-live",
        {
          protocol: "openai-compatible",
          baseUrl: "wss://api.example.com/realtime",
          apiKey: "secret",
          model: "translate-fast",
        },
        { purpose: "live-audio" },
      ),
    /protocol is not inferred from baseUrl/,
  );

  const textOnly = new ProviderRegistry([
    realtimeDefinition({
      id: "vendor-text",
      protocol: "vendor-text-v1",
      capabilities: { streamingAudioInput: false },
    }),
  ]);
  assert.throws(
    () =>
      textOnly.createProfile(
        "vendor-text",
        {
          protocol: "vendor-text-v1",
          baseUrl: "wss://api.example.com/v1",
          apiKey: "secret",
          model: "text-model",
        },
        { purpose: "live-audio" },
      ),
    /does not declare streaming audio input support/,
  );
});

test("BYOK secret is not enumerable or serialized", () => {
  let receivedContext;
  const registry = new ProviderRegistry([realtimeDefinition()]);
  const profile = registry.createProfile(
    "vendor-live",
    {
      protocol: "vendor-realtime-v1",
      baseUrl: "wss://api.example.com/realtime",
      apiKey: "do-not-log-this",
      model: "translate-fast",
    },
    { purpose: "live-audio" },
  );

  assert.equal(getProviderApiKey(profile), "do-not-log-this");
  assert.doesNotMatch(JSON.stringify(profile), /do-not-log-this/);
  assert.deepEqual(Object.keys(profile), [
    "provider",
    "protocol",
    "baseUrl",
    "model",
    "capabilities",
  ]);
  const runtimeRegistry = new ProviderRegistry([
    realtimeDefinition({
      create: (context) => {
        receivedContext = context;
        return { connected: true };
      },
    }),
  ]);
  const runtimeProfile = runtimeRegistry.createProfile(
    "vendor-live",
    {
      protocol: "vendor-realtime-v1",
      baseUrl: "wss://api.example.com/realtime",
      apiKey: "do-not-log-this",
      model: "translate-fast",
    },
    { purpose: "live-audio" },
  );
  assert.deepEqual(runtimeRegistry.create("vendor-live", runtimeProfile), { connected: true });
  assert.equal(receivedContext.apiKey, "do-not-log-this");
  assert.doesNotMatch(JSON.stringify(receivedContext), /do-not-log-this/);
  assert.throws(
    () =>
      runtimeRegistry.create("vendor-live", {
        provider: "vendor-live",
        protocol: "vendor-realtime-v1",
      }),
    /not created by this registry contract/,
  );
});

test("profile capabilities come from the adapter and cannot be supplied by configuration", () => {
  const registry = new ProviderRegistry([realtimeDefinition()]);
  assert.throws(
    () =>
      registry.createProfile("vendor-live", {
        protocol: "vendor-realtime-v1",
        baseUrl: "wss://api.example.com/realtime",
        apiKey: "secret",
        model: "translate-fast",
        capabilities: { streamingAudioInput: true },
      }),
    /Unknown provider profile field: capabilities/,
  );
  assert.throws(() => registry.register(realtimeDefinition()), /already registered/);
  assert.throws(() => registry.get("missing"), /Unsupported provider adapter/);
  assert.throws(() => registry.createProfile("vendor-live", null), /must be an object/);
  assert.throws(
    () =>
      registry.createProfile("vendor-live", {
        protocol: "vendor-realtime-v1",
        baseUrl: "wss://api.example.com/realtime",
        apiKey: "secret\r\nInjected: header",
        model: "translate-fast",
      }),
    /Invalid provider API key/,
  );
});

test("cloud endpoint validation rejects credentials, insecure schemes and local targets", () => {
  const registry = new ProviderRegistry([realtimeDefinition()]);
  const common = { protocol: "vendor-realtime-v1", apiKey: "secret", model: "model" };
  for (const baseUrl of [
    "ws://api.example.com/realtime",
    "wss://token@api.example.com/realtime",
    "wss://localhost/realtime",
    "wss://127.0.0.1/realtime",
    "wss://[::1]/realtime",
    "wss://169.254.169.254/latest/meta-data",
  ]) {
    assert.throws(() => registry.createProfile("vendor-live", { ...common, baseUrl }));
  }

  const localProfile = registry.createProfile(
    "vendor-live",
    { ...common, baseUrl: "wss://127.0.0.1:9443/realtime" },
    { allowPrivateEndpoint: true },
  );
  assert.equal(localProfile.baseUrl, "wss://127.0.0.1:9443/realtime");
});

test("resolution check rejects DNS names that resolve to private addresses", async () => {
  await assert.rejects(
    () =>
      assertEndpointResolutionAllowed("wss://api.example.com/realtime", {
        lookup: async () => [{ address: "10.0.0.2", family: 4 }],
      }),
    /resolves to a private or special-use address/,
  );
  await assert.rejects(
    () =>
      assertEndpointResolutionAllowed("wss://api.example.com/realtime", {
        lookup: async () => [{ address: "not-an-ip", family: 4 }],
      }),
    /resolves to a private or special-use address/,
  );
  await assert.doesNotReject(() =>
    assertEndpointResolutionAllowed("wss://api.example.com/realtime", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
  );
});

test("private and special-use IP classification covers IPv4 and IPv6", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "172.16.1.2",
    "192.168.1.2",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateOrSpecialIp(address), true, address);
  }
  assert.equal(isPrivateOrSpecialIp("93.184.216.34"), false);
  assert.equal(isPrivateOrSpecialIp("2606:2800:220:1:248:1893:25c8:1946"), false);
});
