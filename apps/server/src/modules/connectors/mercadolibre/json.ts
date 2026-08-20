/**
 * Mercado Libre is migrating identifiers to Int64. JSON.parse would silently round
 * integers above Number.MAX_SAFE_INTEGER, so quote unsafe integer literals before
 * parsing. Ordinary decimals/counts remain numbers.
 */
export function parseMercadoLibreJson<T>(text: string): T {
  let output = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < text.length) {
    const char = text[i]!;
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      i += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      i += 1;
      continue;
    }

    const isNumberStart = /[0-9-]/.test(char) && (char !== "-" || /[0-9]/.test(text[i + 1] ?? ""));
    if (!isNumberStart) {
      output += char;
      i += 1;
      continue;
    }

    let end = i + 1;
    while (end < text.length && /[0-9eE+\-.]/.test(text[end]!)) end += 1;
    const token = text.slice(i, end);
    const integer = /^-?\d+$/.test(token);
    const digits = token.replace(/^-/, "");
    if (integer && digits.length >= 16) output += JSON.stringify(token);
    else output += token;
    i = end;
  }

  return JSON.parse(output) as T;
}
