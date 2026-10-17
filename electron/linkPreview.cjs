// "Marcador web": the page's title, description, picture and icon, read from its HTML
// meta tags (Open Graph, Twitter, <title>, <link rel="icon">) by the app, which isn't
// held back by the browser's cross-origin rules.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? "").trim() : "";
}

/** { title, description, image, icon } from a page's HTML; `base` resolves relative links. */
function parseLinkPreview(html, base) {
  const head = String(html).slice(0, 400000);
  const metas = head.match(/<meta\b[^>]*>/gi) ?? [];
  const meta = (...keys) => {
    for (const key of keys)
      for (const tag of metas) {
        const name = (attr(tag, "property") || attr(tag, "name") || attr(tag, "itemprop")).toLowerCase();
        if (name === key) {
          const content = attr(tag, "content");
          if (content) return content.replace(/\s+/g, " ");
        }
      }
    return "";
  };
  const abs = (url) => {
    try {
      return url ? new URL(url, base).href : "";
    } catch {
      return "";
    }
  };
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "";
  const links = head.match(/<link\b[^>]*>/gi) ?? [];
  const icon =
    links.find((tag) => /(^|\s)(shortcut\s+)?icon(\s|$)/i.test(attr(tag, "rel"))) ??
    links.find((tag) => /apple-touch-icon/i.test(attr(tag, "rel")));
  return {
    title: meta("og:title", "twitter:title") || decode(title).replace(/\s+/g, " ").trim(),
    description: meta("og:description", "twitter:description", "description"),
    image: abs(meta("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src", "image")),
    icon: abs(icon ? attr(icon, "href") : "/favicon.ico"),
  };
}

async function fetchLinkPreview(url) {
  if (!/^https?:\/\//i.test(String(url))) return null;
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "accept-language": "es,en;q=0.8",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    },
  });
  if (!res.ok) return null;
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("image/")) return { title: "", description: "", image: res.url, icon: "" };
  if (!type.includes("html")) return null;
  return parseLinkPreview(await res.text(), res.url);
}

module.exports = { parseLinkPreview, fetchLinkPreview };
