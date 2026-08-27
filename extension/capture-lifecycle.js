(function exposeCaptureLifecycle(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.AudioTranslateCaptureLifecycle = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  function requiredFunction(value, label) {
    if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
    return value;
  }

  async function prepareThenAttach(operations = {}) {
    const prepareLocalSession = requiredFunction(
      operations.prepareLocalSession,
      "prepareLocalSession",
    );
    const getTabStreamId = requiredFunction(operations.getTabStreamId, "getTabStreamId");
    const attachTabStream = requiredFunction(operations.attachTabStream, "attachTabStream");
    const cancelPreparedSession = requiredFunction(
      operations.cancelPreparedSession,
      "cancelPreparedSession",
    );
    let prepared = false;
    let preparation;
    try {
      preparation = await prepareLocalSession();
      prepared = true;
      const streamId = await getTabStreamId();
      const attachment = await attachTabStream(streamId);
      return { preparation, attachment };
    } catch (error) {
      if (prepared) {
        try {
          await cancelPreparedSession();
        } catch {
          // Preserve the actionable preparation/stream/attachment error.
        }
      }
      throw error;
    }
  }

  return { prepareThenAttach };
});
