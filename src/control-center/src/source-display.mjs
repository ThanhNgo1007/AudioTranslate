function cleanDisplayText(candidate) {
  return typeof candidate === "string"
    ? candidate.replace(/[\u0000-\u001f\u007f]/g, "").trim()
    : "";
}

function rendererOwnedBasename(candidate) {
  const value = cleanDisplayText(candidate);
  if (!value) return "";
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || "";
}

export function rendererOwnedSourceLabel({
  sourceKind,
  selectedFileName = "",
  tabSourceSelected = false,
  mainLabel = "",
} = {}) {
  if (sourceKind === "file") {
    return rendererOwnedBasename(selectedFileName)
      || cleanDisplayText(mainLabel)
      || "Chưa chọn tệp";
  }
  if (tabSourceSelected) return "Tab Chrome / Edge đã chọn";
  return cleanDisplayText(mainLabel) || "Chưa kết nối tab";
}
