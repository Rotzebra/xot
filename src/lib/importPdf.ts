// "Importar > PDF": the text of a PDF as headings and paragraphs, read by hand (no PDF library):
// objects and object streams, Flate-compressed content, fonts' ToUnicode maps and simple
// encodings, and text positions to tell lines, paragraphs and headings apart. Encrypted or
// scanned PDFs have no text to read; the importer keeps the file itself for those.

type Name = { t: "name"; v: string };
type Str = { t: "str"; v: string };
type Ref = { t: "ref"; n: number };
type Op = { t: "op"; v: string };
type Dict = { t: "dict"; v: Record<string, Value> };
type Value = number | boolean | null | Name | Str | Ref | Op | Dict | Value[];

const isName = (v: Value | undefined): v is Name => !!v && typeof v === "object" && !Array.isArray(v) && v.t === "name";
const isStr = (v: Value | undefined): v is Str => !!v && typeof v === "object" && !Array.isArray(v) && v.t === "str";
const isRef = (v: Value | undefined): v is Ref => !!v && typeof v === "object" && !Array.isArray(v) && v.t === "ref";
const isDict = (v: Value | undefined): v is Dict => !!v && typeof v === "object" && !Array.isArray(v) && v.t === "dict";

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...")(<>[]{}/%"].map((c) => c.charCodeAt(0)));

/** Bytes as a string of char codes 0-255, so offsets and bytes line up. */
function latin1(bytes: Uint8Array) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** A PDF tokenizer and value parser over a latin1 string. */
class Lexer {
  pos: number;
  constructor(
    readonly s: string,
    pos = 0,
  ) {
    this.pos = pos;
  }
  skip() {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (WHITE.has(c)) this.pos++;
      else if (c === 37) {
        while (this.pos < s.length && s[this.pos] !== "\n" && s[this.pos] !== "\r") this.pos++;
      } else break;
    }
  }
  private word() {
    const start = this.pos;
    while (this.pos < this.s.length) {
      const c = this.s.charCodeAt(this.pos);
      if (WHITE.has(c) || DELIM.has(c)) break;
      this.pos++;
    }
    return this.s.slice(start, this.pos);
  }
  /** The next value, or undefined at the end. */
  value(): Value | undefined {
    this.skip();
    const s = this.s;
    if (this.pos >= s.length) return undefined;
    const c = s[this.pos];
    if (c === "<" && s[this.pos + 1] === "<") {
      this.pos += 2;
      const v: Record<string, Value> = {};
      for (;;) {
        this.skip();
        if (this.pos >= s.length) break;
        if (s[this.pos] === ">" && s[this.pos + 1] === ">") {
          this.pos += 2;
          break;
        }
        const key = this.value();
        if (!isName(key)) {
          if (key === undefined) break;
          continue;
        }
        const val = this.value();
        if (val === undefined) break;
        v[key.v] = val;
      }
      return { t: "dict", v };
    }
    if (c === "<") {
      const end = s.indexOf(">", this.pos);
      const hex = s.slice(this.pos + 1, end < 0 ? s.length : end).replace(/[^0-9a-f]/gi, "");
      this.pos = end < 0 ? s.length : end + 1;
      let out = "";
      for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt((hex.slice(i, i + 2) + "0").slice(0, 2), 16));
      return { t: "str", v: out };
    }
    if (c === "[") {
      this.pos++;
      const arr: Value[] = [];
      for (;;) {
        this.skip();
        if (this.pos >= s.length) break;
        if (s[this.pos] === "]") {
          this.pos++;
          break;
        }
        const v = this.value();
        if (v === undefined) break;
        arr.push(v);
      }
      return arr;
    }
    if (c === "(") {
      this.pos++;
      let depth = 1;
      let out = "";
      while (this.pos < s.length) {
        const ch = s[this.pos++];
        if (ch === "\\") {
          const n = s[this.pos++];
          if (n === "n") out += "\n";
          else if (n === "r") out += "\r";
          else if (n === "t") out += "\t";
          else if (n === "b") out += "\b";
          else if (n === "f") out += "\f";
          else if (n === "\r") {
            if (s[this.pos] === "\n") this.pos++;
          } else if (n === "\n") {
            /* line continuation */
          } else if (n >= "0" && n <= "7") {
            let oct = n;
            while (oct.length < 3 && s[this.pos] >= "0" && s[this.pos] <= "7") oct += s[this.pos++];
            out += String.fromCharCode(parseInt(oct, 8) & 0xff);
          } else out += n ?? "";
        } else if (ch === "(") {
          depth++;
          out += ch;
        } else if (ch === ")") {
          if (--depth === 0) break;
          out += ch;
        } else out += ch;
      }
      return { t: "str", v: out };
    }
    if (c === "/") {
      this.pos++;
      return { t: "name", v: this.word().replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === ")" || c === ">" || c === "]" || c === "}" || c === "{") {
      this.pos++;
      return { t: "op", v: c };
    }
    const w = this.word();
    if (!w) {
      this.pos++;
      return { t: "op", v: c };
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = Number(w);
      // "12 0 R": a reference.
      if (/^\d+$/.test(w)) {
        const save = this.pos;
        const m = /^\s+(\d+)\s+R(?=[\s/<>[\]()%]|$)/.exec(s.slice(this.pos, this.pos + 24));
        if (m) {
          this.pos = save + m[0].length;
          return { t: "ref", n };
        }
      }
      return n;
    }
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    return { t: "op", v: w };
  }
}

/** Inflates zlib data, keeping what came out before any error (streams often end with junk). */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    /* truncated or trailing bytes: keep what was read */
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

type PdfObject = { value: Value; stream?: Uint8Array };

class Pdf {
  objects = new Map<number, PdfObject>();
  trailer: Record<string, Value> = {};
  constructor(readonly s: string) {}

  static async read(bytes: Uint8Array) {
    const pdf = new Pdf(latin1(bytes));
    pdf.scan();
    await pdf.expandObjectStreams();
    return pdf;
  }

  private scan() {
    const s = this.s;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const lex = new Lexer(s, m.index + m[0].length);
      const value = lex.value();
      if (value === undefined) break;
      lex.skip();
      let stream: Uint8Array | undefined;
      if (s.startsWith("stream", lex.pos)) {
        let start = lex.pos + 6;
        if (s[start] === "\r") start++;
        if (s[start] === "\n") start++;
        const len = isDict(value) ? value.v.Length : undefined;
        let end = typeof len === "number" ? start + len : -1;
        if (end < 0 || !s.slice(end, end + 24).replace(/^\s+/, "").startsWith("endstream")) {
          const at = s.indexOf("endstream", start);
          end = at < 0 ? s.length : at;
        }
        stream = bytesOf(s.slice(start, end));
        re.lastIndex = end;
      } else re.lastIndex = lex.pos;
      this.objects.set(Number(m[1]), { value, stream });
      if (isDict(value) && isName(value.v.Type) && value.v.Type.v === "XRef") Object.assign(this.trailer, value.v);
    }
    // Classic trailers (the last one wins, as with incremental updates).
    const tre = /trailer\s*<</g;
    while ((m = tre.exec(s))) {
      const v = new Lexer(s, m.index + 7).value();
      if (isDict(v)) Object.assign(this.trailer, v.v);
    }
  }

  private async expandObjectStreams() {
    for (const obj of [...this.objects.values()]) {
      const d = obj.value;
      if (!isDict(d) || !isName(d.v.Type) || d.v.Type.v !== "ObjStm" || !obj.stream) continue;
      const data = latin1(await this.decode(obj));
      const n = Number(d.v.N) || 0;
      const firstAt = Number(d.v.First) || 0;
      const head = new Lexer(data);
      const pairs: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const num = head.value();
        const off = head.value();
        if (typeof num !== "number" || typeof off !== "number") break;
        pairs.push([num, off]);
      }
      for (const [num, off] of pairs) {
        if (this.objects.has(num)) continue;
        const value = new Lexer(data, firstAt + off).value();
        if (value !== undefined) this.objects.set(num, { value });
      }
    }
  }

  get(v: Value | undefined, depth = 0): Value | undefined {
    if (isRef(v) && depth < 16) return this.get(this.objects.get(v.n)?.value, depth + 1);
    return v;
  }
  dict(v: Value | undefined): Record<string, Value> | null {
    const d = this.get(v);
    return isDict(d) ? d.v : null;
  }
  object(v: Value | undefined): PdfObject | undefined {
    return isRef(v) ? this.objects.get(v.n) : undefined;
  }

  /** A stream's bytes, decompressed (Flate; other filters are left as they are). */
  async decode(obj: PdfObject | undefined): Promise<Uint8Array> {
    if (!obj?.stream) return new Uint8Array();
    const d = isDict(obj.value) ? obj.value.v : {};
    const filter = this.get(d.Filter);
    const filters = (Array.isArray(filter) ? filter : filter ? [filter] : []).map((f) => (isName(f) ? f.v : ""));
    let data = obj.stream;
    for (const f of filters) {
      if (f === "FlateDecode" || f === "Fl") data = await inflate(data);
      else if (f === "ASCIIHexDecode" || f === "AHx") {
        const hex = latin1(data).replace(/[^0-9a-f]/gi, "");
        data = Uint8Array.from({ length: hex.length >> 1 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
      } else return new Uint8Array();
    }
    return data;
  }
}

// ------------------------------------------------------------------ fonts

/** Unicode for the glyph names that /Differences use most. */
const GLYPHS: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'",
  parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[",
  backslash: "\\", bracketright: "]", underscore: "_", braceleft: "{", bar: "|", braceright: "}", asciitilde: "~",
  quoteleft: "‘", quoteright: "’", quotedblleft: "“", quotedblright: "”", bullet: "•", endash: "–", emdash: "—",
  ellipsis: "…", fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", exclamdown: "¡", questiondown: "¿",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É",
  Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", udieresis: "ü", Udieresis: "Ü", ccedilla: "ç", degree: "°",
  copyright: "©", registered: "®", trademark: "™", euro: "€", section: "§", ordfeminine: "ª", ordmasculine: "º",
  minus: "−", multiply: "×", divide: "÷", periodcentered: "·", guillemotleft: "«", guillemotright: "»", nbspace: " ",
};

const win1252 = new TextDecoder("windows-1252");
const macRoman = (() => {
  try {
    return new TextDecoder("macintosh");
  } catch {
    return win1252;
  }
})();

interface Font {
  /** Bytes per character code. */
  bytes: 1 | 2;
  decode: (code: number) => string;
  /** Advance width of a code, in text space units (1/1000 of the size). */
  width: (code: number) => number;
}

function parseCMap(text: string) {
  const map = new Map<number, string>();
  let bytes: 1 | 2 = 1;
  const utf16 = (hex: string) => {
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    if (hex.length === 2) out = String.fromCharCode(parseInt(hex, 16));
    return out;
  };
  const space = /begincodespacerange\s*<([0-9a-f]+)>/i.exec(text);
  if (space && space[1].length >= 4) bytes = 2;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/gi))
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) {
      if (m[1].length >= 4) bytes = 2;
      map.set(parseInt(m[1], 16), utf16(m[2]));
    }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/gi))
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(?:<([0-9a-f]*)>|\[([^\]]*)\])/gi)) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 0xffff);
      if (m[1].length >= 4) bytes = 2;
      if (m[3] !== undefined) {
        const base = m[3];
        const last = parseInt(base.slice(-4) || "0", 16);
        for (let c = lo; c <= hi; c++) map.set(c, utf16(base.slice(0, -4)) + String.fromCharCode(last + c - lo));
      } else {
        const items = [...m[4].matchAll(/<([0-9a-f]*)>/gi)].map((x) => utf16(x[1]));
        items.forEach((u, i) => map.set(lo + i, u));
      }
    }
  return { map, bytes };
}

async function loadFont(pdf: Pdf, ref: Value | undefined): Promise<Font> {
  const font = pdf.dict(ref) ?? {};
  const subtype = isName(font.Subtype) ? font.Subtype.v : "";
  const type0 = subtype === "Type0";
  let toUnicode: Map<number, string> | null = null;
  let bytes: 1 | 2 = type0 ? 2 : 1;
  const tu = pdf.object(font.ToUnicode);
  if (tu) {
    const cmap = parseCMap(latin1(await pdf.decode(tu)));
    toUnicode = cmap.map;
    if (!type0) bytes = 1;
    else bytes = cmap.bytes;
  }
  // Widths: simple fonts' /Widths from /FirstChar, Type0's /W in its descendant (else /DW).
  const widths = new Map<number, number>();
  let fallback = type0 ? 1000 : 500;
  if (type0) {
    const desc = pdf.dict((pdf.get(font.DescendantFonts) as Value[] | undefined)?.[0]) ?? {};
    if (typeof desc.DW === "number") fallback = desc.DW;
    const w = pdf.get(desc.W);
    if (Array.isArray(w))
      for (let i = 0; i < w.length; ) {
        const start = pdf.get(w[i]);
        const next = pdf.get(w[i + 1]);
        if (typeof start !== "number") break;
        if (Array.isArray(next)) {
          next.forEach((x, k) => typeof x === "number" && widths.set(start + k, x));
          i += 2;
        } else {
          const end = Number(next);
          const width = Number(pdf.get(w[i + 2]));
          for (let c = start; c <= end && c - start < 0xffff; c++) widths.set(c, width);
          i += 3;
        }
      }
  } else {
    const firstChar = Number(pdf.get(font.FirstChar) ?? 0);
    const list = pdf.get(font.Widths);
    if (Array.isArray(list)) list.forEach((x, i) => typeof x === "number" && widths.set(firstChar + i, x));
  }
  // Simple fonts without a ToUnicode map: their encoding (and /Differences).
  let base = win1252;
  const differences = new Map<number, string>();
  const enc = pdf.get(font.Encoding);
  const encName = isName(enc) ? enc.v : isDict(enc) && isName(enc.v.BaseEncoding) ? enc.v.BaseEncoding.v : "";
  if (encName === "MacRomanEncoding") base = macRoman;
  if (isDict(enc) && Array.isArray(pdf.get(enc.v.Differences))) {
    let code = 0;
    for (const item of pdf.get(enc.v.Differences) as Value[]) {
      if (typeof item === "number") code = item;
      else if (isName(item)) {
        const name = item.v;
        const uni = /^uni([0-9A-F]{4})$/i.exec(name);
        const glyph = GLYPHS[name] ?? (uni ? String.fromCharCode(parseInt(uni[1], 16)) : name.length === 1 ? name : /^[a-zA-Z]+$/.test(name) ? "" : "");
        differences.set(code++, glyph);
      }
    }
  }
  return {
    bytes,
    width: (code) => widths.get(code) ?? fallback,
    decode: (code) => {
      const uni = toUnicode?.get(code);
      if (uni !== undefined) return uni;
      if (type0) return "";
      const diff = differences.get(code);
      if (diff !== undefined) return diff;
      return code < 32 ? "" : base.decode(new Uint8Array([code]));
    },
  };
}

// ------------------------------------------------------------------- text

type Line = { text: string; size: number; y: number; x: number; page: number };
type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** The text of one content stream (and the forms it draws), as positioned lines. */
async function readContent(
  pdf: Pdf,
  content: Uint8Array,
  resources: Record<string, Value>,
  page: number,
  lines: Line[],
  ctm0: Matrix = IDENTITY,
  depth = 0,
) {
  const fonts = new Map<string, Promise<Font>>();
  const fontDict = pdf.dict(resources.Font) ?? {};
  const xobjects = pdf.dict(resources.XObject) ?? {};
  const lex = new Lexer(latin1(content));
  const stack: Value[] = [];
  const saved: Matrix[] = [];
  let ctm = ctm0;
  let tm: Matrix = IDENTITY;
  let lm: Matrix = IDENTITY;
  let font: Font | null = null;
  let size = 12;
  let leading = 0;
  let charSpace = 0;
  let wordSpace = 0;
  let scale = 1;
  let rise = 0;
  // The line being written: where the last glyph ended, in device space.
  let current: Line | null = null;
  let endX = 0;

  const fontSize = () => {
    const m = multiply(tm, ctm);
    return Math.abs(size) * Math.hypot(m[2], m[3]) || Math.abs(size);
  };
  const show = (str: string) => {
    if (!font) return;
    const m = multiply([1, 0, 0, 1, 0, rise], multiply(tm, ctm));
    const x = m[4];
    const y = m[5];
    const fs = fontSize();
    let text = "";
    let advance = 0;
    for (let i = 0; i < str.length; i += font.bytes) {
      const code = font.bytes === 2 ? (str.charCodeAt(i) << 8) | (str.charCodeAt(i + 1) || 0) : str.charCodeAt(i);
      text += font.decode(code);
      advance += ((font.width(code) / 1000) * size + charSpace + (code === 32 && font.bytes === 1 ? wordSpace : 0)) * scale;
    }
    tm = multiply([1, 0, 0, 1, advance, 0], tm);
    const end = multiply(tm, ctm)[4];
    if (!text) return;
    const sameLine = current && current.page === page && Math.abs(current.y - y) < Math.max(fs, current.size) * 0.5;
    if (!sameLine) {
      current = { text: "", size: fs, y, x, page };
      lines.push(current);
    } else if (x - endX > fs * 0.15 && !/\s$/.test(current!.text) && !/^\s/.test(text)) current!.text += " ";
    current!.text += text;
    current!.size = Math.max(current!.size, fs);
    endX = end;
  };

  for (let guard = 0; guard < 2_000_000; guard++) {
    const tok = lex.value();
    if (tok === undefined) break;
    if (!(tok && typeof tok === "object" && !Array.isArray(tok) && tok.t === "op")) {
      stack.push(tok);
      continue;
    }
    const op = tok.v;
    const num = (i: number) => Number(stack[stack.length - i] ?? 0);
    switch (op) {
      case "q":
        saved.push(ctm);
        break;
      case "Q":
        ctm = saved.pop() ?? ctm;
        break;
      case "cm":
        ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], ctm);
        break;
      case "BT":
        tm = lm = IDENTITY;
        break;
      case "Tf": {
        const name = stack[stack.length - 2];
        size = num(1);
        if (isName(name)) {
          if (!fonts.has(name.v)) fonts.set(name.v, loadFont(pdf, fontDict[name.v]));
          font = await fonts.get(name.v)!;
        }
        break;
      }
      case "TL":
        leading = num(1);
        break;
      case "Tc":
        charSpace = num(1);
        break;
      case "Tw":
        wordSpace = num(1);
        break;
      case "Tz":
        scale = num(1) / 100;
        break;
      case "Ts":
        rise = num(1);
        break;
      case "Td":
        tm = lm = multiply([1, 0, 0, 1, num(2), num(1)], lm);
        break;
      case "TD":
        leading = -num(1);
        tm = lm = multiply([1, 0, 0, 1, num(2), num(1)], lm);
        break;
      case "Tm":
        tm = lm = [num(6), num(5), num(4), num(3), num(2), num(1)];
        break;
      case "T*":
        tm = lm = multiply([1, 0, 0, 1, 0, -leading], lm);
        break;
      case "Tj": {
        const s = stack[stack.length - 1];
        if (isStr(s)) show(s.v);
        break;
      }
      case "'":
      case '"': {
        tm = lm = multiply([1, 0, 0, 1, 0, -leading], lm);
        if (op === '"') {
          wordSpace = num(3);
          charSpace = num(2);
        }
        const s = stack[stack.length - 1];
        if (isStr(s)) show(s.v);
        break;
      }
      case "TJ": {
        const arr = stack[stack.length - 1];
        if (Array.isArray(arr))
          for (const item of arr) {
            if (isStr(item)) show(item.v);
            else if (typeof item === "number") {
              // Kerning moves the pen back; a big gap is a space between words.
              const dx = (-item / 1000) * size * scale;
              tm = multiply([1, 0, 0, 1, dx, 0], tm);
              const line = current as Line | null;
              if (item < -200 && line && !/\s$/.test(line.text)) line.text += " ";
              endX = multiply(tm, ctm)[4];
            }
          }
        break;
      }
      case "BI": {
        // Inline images: their bytes until "EI".
        const at = lex.s.slice(lex.pos).search(/\sEI(?=[\s]|$)/);
        lex.pos = at < 0 ? lex.s.length : lex.pos + at + 3;
        break;
      }
      case "Do": {
        const name = stack[stack.length - 1];
        const ref = isName(name) ? xobjects[name.v] : undefined;
        const obj = pdf.object(ref);
        const d = obj && isDict(obj.value) ? obj.value.v : null;
        if (d && isName(d.Subtype) && d.Subtype.v === "Form" && depth < 4) {
          const matrix = pdf.get(d.Matrix);
          const m = Array.isArray(matrix) && matrix.length === 6 ? (matrix.map(Number) as Matrix) : IDENTITY;
          await readContent(pdf, await pdf.decode(obj), pdf.dict(d.Resources) ?? resources, page, lines, multiply(m, ctm), depth + 1);
          current = null;
        }
        break;
      }
    }
    stack.length = 0;
  }
}

/** Text strings in /Info: UTF-16 with a BOM, else PDFDocEncoding (close to Latin-1). */
function textString(s: string) {
  if (s.startsWith("\xfe\xff")) {
    let out = "";
    for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return out;
  }
  return s;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A document's metadata title, when it names the document: the ones apps write on their own
 * ("about:blank" from a browser, "Microsoft Word - doc1.docx", "Untitled", a URL) are left out,
 * so the page is named after the file.
 */
export function usefulTitle(title: string | null | undefined): string | null {
  const t = title?.trim();
  if (!t || /^(about:blank|untitled|sin t[ií]tulo|microsoft (word|powerpoint|excel) - )|^https?:|^file:|\.(docx?|pdf|pptx?|xlsx?|html?)$/i.test(t)) return null;
  return t;
}

/**
 * A PDF's text as HTML (headings by font size, paragraphs by spacing) with its title, for the HTML
 * importer. `html` is empty when there is no text to read (encrypted or scanned files).
 */
export async function pdfToHtml(buffer: ArrayBuffer): Promise<{ title: string | null; html: string }> {
  const pdf = await Pdf.read(new Uint8Array(buffer));
  const info = pdf.dict(pdf.trailer.Info);
  const rawTitle = info ? pdf.get(info.Title) : undefined;
  const title = usefulTitle(isStr(rawTitle) ? textString(rawTitle.v) : null);
  if (pdf.trailer.Encrypt) return { title, html: "" };
  // Pages in order, with the resources they inherit from their parents.
  const root = pdf.dict(pdf.trailer.Root) ?? [...pdf.objects.values()].map((o) => o.value).find((v): v is Dict => isDict(v) && isName(v.v.Type) && v.v.Type.v === "Catalog")?.v;
  const pages: { page: Record<string, Value>; resources: Record<string, Value> }[] = [];
  const seen = new Set<Value>();
  const walk = (node: Value | undefined, inherited: Record<string, Value>) => {
    if (seen.has(node as Value) || pages.length > 2000) return;
    seen.add(node as Value);
    const d = pdf.dict(node);
    if (!d) return;
    const resources = pdf.dict(d.Resources) ?? inherited;
    const kidsList = pdf.get(d.Kids);
    if (Array.isArray(kidsList)) kidsList.forEach((k) => walk(k, resources));
    else pages.push({ page: d, resources });
  };
  walk(root?.Pages, {});
  const lines: Line[] = [];
  for (const [i, { page, resources }] of pages.entries()) {
    const contents = pdf.get(page.Contents);
    const refs = Array.isArray(contents) ? contents : [page.Contents];
    const parts = await Promise.all(refs.map((r) => pdf.decode(pdf.object(r))));
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      joined[at + p.length] = 10;
      at += p.length + 1;
    }
    await readContent(pdf, joined, resources, i, lines);
  }
  const trimmed = lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
  // Page numbers: a lone number that starts or ends its page.
  const textLines = trimmed.filter(
    (l, i) => !/^\d{1,4}$/.test(l.text) || (trimmed[i - 1]?.page === l.page && trimmed[i + 1]?.page === l.page),
  );
  if (!textLines.length) return { title, html: "" };

  // The body's size is the most common one; bigger, short lines are headings.
  const counts = new Map<number, number>();
  for (const l of textLines) counts.set(Math.round(l.size), (counts.get(Math.round(l.size)) ?? 0) + l.text.length);
  const body = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const level = (l: Line) => (l.text.length > 120 ? 0 : l.size >= body * 1.6 ? 1 : l.size >= body * 1.3 ? 2 : l.size >= body * 1.12 ? 3 : 0);

  let html = "";
  let para: string[] = [];
  const flush = () => {
    if (para.length) html += `<p>${escapeHtml(para.join(" ").replace(/(\w)- (\w)/g, "$1$2"))}</p>`;
    para = [];
  };
  let prev: Line | null = null;
  for (const l of textLines) {
    const h = level(l);
    if (h) {
      flush();
      // A heading broken over two lines stays one.
      if (prev && level(prev) === h && prev.page === l.page && Math.abs(prev.y - l.y) < l.size * 1.6 && html.endsWith(`</h${h}>`))
        html = `${html.slice(0, -5)} ${escapeHtml(l.text)}</h${h}>`;
      else html += `<h${h}>${escapeHtml(l.text)}</h${h}>`;
      prev = l;
      continue;
    }
    const gap = prev && prev.page === l.page ? Math.abs(prev.y - l.y) : Infinity;
    const bullet = /^([•▪◦\-–*]|\d+[.)])\s/.test(l.text);
    if (!prev || level(prev) || gap > l.size * 1.75 || bullet || Math.abs(prev.size - l.size) > 1) flush();
    para.push(l.text);
    prev = l;
  }
  flush();
  return { title, html: `<!doctype html><html><body>${html}</body></html>` };
}
