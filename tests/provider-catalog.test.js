const test = require("node:test");
const assert = require("node:assert/strict");
const { PROVIDER_CAPABILITIES, getProviderCapabilities } = require("../src/provider-factory");
const {
  PROVIDERS,
  getProvider,
  listProviders,
  renderProviderCatalog,
} = require("../src/provider-catalog");

test("only factory-backed demo, Azure and Gemini entries are runnable", () => {
  const runnableIds = listProviders({ runnableOnly: true })
    .map((provider) => provider.id)
    .sort();
  assert.deepEqual(runnableIds, ["azure", "demo", "gemini"]);
  assert.deepEqual(runnableIds, Object.keys(PROVIDER_CAPABILITIES).sort());
  for (const id of runnableIds) assert.doesNotThrow(() => getProviderCapabilities(id));
});

test("planned providers are disabled and include cost, privacy and remediation metadata", () => {
  for (const id of ["openai", "together", "local"]) {
    const provider = getProvider(id.toUpperCase());
    assert.equal(provider.runnable, false);
    assert.equal(provider.status, "in-development");
    assert.equal(provider.checkedAt, "2026-08-24");
    assert.ok(provider.cost.summary.length > 20);
    assert.ok(provider.privacy.summary.length > 20);
    assert.ok(provider.remediation.length > 20);
    assert.throws(() => getProviderCapabilities(id), /Unsupported provider adapter/);
  }
  const gemini = getProvider("gemini");
  assert.equal(gemini.runnable, true);
  assert.equal(gemini.realTranslation, true);
  assert.match(gemini.privacy.summary, /API key.*không đi vào extension\/renderer/);
});

test("catalog metadata is deeply immutable", () => {
  assert.equal(Object.isFrozen(PROVIDERS), true);
  assert.equal(Object.isFrozen(PROVIDERS.azure.cost), true);
  const original = PROVIDERS.azure.cost.summary;
  PROVIDERS.azure.cost.summary = "free forever";
  assert.equal(PROVIDERS.azure.cost.summary, original);
});

test("human rendering distinguishes runnable, disabled and BYOK cost", () => {
  const output = renderProviderCatalog();
  assert.match(output, /demo .*\[RUNNABLE\]/);
  assert.match(output, /azure .*\[RUNNABLE\]/);
  assert.match(output, /gemini .*\[RUNNABLE\]/);
  assert.match(output, /BYOK không đồng nghĩa miễn phí/);
  assert.match(output, /kiểm tra 2026-08-24/);
});

test("JSON rendering and lookup expose no runtime secrets", () => {
  const output = renderProviderCatalog({ json: true });
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 6);
  assert.equal(getProvider(" azure "), PROVIDERS.azure);
  assert.doesNotMatch(output, /apiKey|AZURE_SPEECH_KEY=/);
  assert.throws(() => getProvider("missing"), /Unsupported provider catalog entry/);
});
