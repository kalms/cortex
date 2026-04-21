const KNOWN_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];

export function normalize(input: string, project: string): string {
  if (!input) throw new Error("normalize: input is empty");

  if (input.includes("::")) {
    if (!project) throw new Error("normalize: project is required for colon-form input");
    const [filePath, symbol] = input.split("::", 2);
    let fileNoExt = filePath;
    for (const ext of KNOWN_EXTENSIONS) {
      if (fileNoExt.endsWith(ext)) {
        fileNoExt = fileNoExt.slice(0, -ext.length);
        break;
      }
    }
    const fileDotted = fileNoExt.split("/").join(".");
    return `${project}.${fileDotted}.${symbol}`;
  }

  return input;
}

export function denormalize(stored: string, filePath: string): string {
  if (!filePath) return stored;
  let fileNoExt = filePath;
  for (const ext of KNOWN_EXTENSIONS) {
    if (fileNoExt.endsWith(ext)) {
      fileNoExt = fileNoExt.slice(0, -ext.length);
      break;
    }
  }
  const fileDotted = fileNoExt.split("/").join(".");
  const idx = stored.indexOf(`.${fileDotted}.`);
  if (idx === -1) return stored;
  const symbol = stored.slice(idx + fileDotted.length + 2);
  return `${filePath}::${symbol}`;
}
