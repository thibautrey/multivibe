/** Parse generated LangChain Python literal data without eval, imports or execution. */
export function parseProfiles(text: string): Record<string, unknown> {
  const marker = text.match(/^_?PROFILES[^=\n]*=\s*/m);
  if (!marker || marker.index === undefined) throw Error("LangChain profiles assignment missing");
  let at = marker.index + marker[0].length;
  const skip = () => { while (at < text.length) { if (/\s/.test(text[at])) at++; else if (text[at] === "#") { while (at < text.length && text[at] !== "\n") at++; } else break; } };
  function value(depth = 0): any {
    if (depth > 30) throw Error("Profile nesting limit");
    skip(); const ch = text[at++];
    if (ch === '"' || ch === "'") {
      let result = "";
      while (at < text.length) {
        const c = text[at++]; if (c === ch) return result;
        if (c !== "\\") { result += c; continue; }
        const e = text[at++];
        if (e === "u" || e === "x") { const n = e === "u" ? 4 : 2; const h = text.slice(at, at + n); if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(h)) throw Error("Invalid escape"); result += String.fromCharCode(parseInt(h, 16)); at += n; }
        else result += ({ n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'" } as Record<string, string>)[e] ?? (() => { throw Error("Unsupported escape"); })();
      }
      throw Error("Unterminated string");
    }
    if (ch === "{" || ch === "[") {
      const out: any = ch === "{" ? Object.create(null) : []; const end = ch === "{" ? "}" : "]";
      skip(); while (text[at] !== end) {
        const item = value(depth + 1); skip();
        if (ch === "{") { if (typeof item !== "string" || text[at++] !== ":") throw Error("Invalid dictionary"); out[item] = value(depth + 1); } else out.push(item);
        skip(); if (text[at] === ",") { at++; skip(); } else if (text[at] !== end) throw Error("Expected separator");
      }
      at++; return out;
    }
    at--;
    const token = text.slice(at).match(/^(True|False|None|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw Error("Only literal profile data is allowed");
    at += token.length; return token === "True" ? true : token === "False" ? false : token === "None" ? null : Number(token);
  }
  const result = value(); skip(); if (at !== text.length || !result || Array.isArray(result) || typeof result !== "object") throw Error("Invalid profiles document");
  return result;
}
