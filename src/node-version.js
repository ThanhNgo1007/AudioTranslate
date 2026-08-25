const MINIMUM_NODE_VERSION = Object.freeze([22, 12, 0]);

function isSupportedNodeVersion(candidate) {
  const match = String(candidate || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    if (current[index] > MINIMUM_NODE_VERSION[index]) return true;
    if (current[index] < MINIMUM_NODE_VERSION[index]) return false;
  }
  return true;
}

module.exports = { MINIMUM_NODE_VERSION, isSupportedNodeVersion };
