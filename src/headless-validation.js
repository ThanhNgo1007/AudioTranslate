const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{24,512}$/;
const WHITESPACE_OR_CONTROL_PATTERN = /[\s\p{Cc}]/u;

function isValidPairingToken(value) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    PAIRING_TOKEN_PATTERN.test(value)
  );
}

function isValidCloudCredential(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !WHITESPACE_OR_CONTROL_PATTERN.test(value)
  );
}

module.exports = {
  isValidCloudCredential,
  isValidPairingToken,
};
