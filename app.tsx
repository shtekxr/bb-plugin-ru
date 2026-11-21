// bb-plugin-ru — translates the bb UI to Russian with a dictionary-driven content script.
import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import dictionary from "./dictionary.json";

const DICT = dictionary as Record<string, string>;
const ATTRS = ["placeholder", "title", "aria-label", "alt"];
const SKIP = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA", "KBD"]);
const MISSING_KEY = "bb-ru-missing";
// Код не переводим на любой глубине: в подсвеченных блоках текст лежит в <span> внутри <pre>/<code>.
const SKIP_SELECTOR = "script,style,code,pre,textarea,kbd,samp,[class*=hljs],[class*=shiki],[class*=highlight],[data-language],[data-code]";
const inSkipped = (el: Element | null) => !!el && (SKIP.has(el.tagName) || !!el.closest(SKIP_SELECTOR));

function plural(n: number, one: string, few: string, many: string) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many;
}
function ruDuration(s: string) {
  return s
    .replace(/\b(\d+)\s*(?:days?|d)\b/g, "$1 д")
    .replace(/\b(\d+)\s*(?:hours?|hrs?|h)\b/g, "$1 ч")
    .replace(/\b(\d+)\s*(?:minutes?|mins?|m)\b/g, "$1 мин")
    .replace(/\b(\d+)\s*(?:seconds?|secs?|s)\b/g, "$1 с");
}
const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^(\d+) threads?$/, (m) => `${m[1]} ${plural(+m[1], "тред", "треда", "тредов")}`],
  [/^(\d+) projects?$/, (m) => `${m[1]} ${plural(+m[1], "проект", "проекта", "проектов")}`],
  [/^(\d+) (?:min|minutes?) ago$/, (m) => `${m[1]} мин. назад`],
  [/^(\d+) (?:hours?|h) ago$/, (m) => `${m[1]} ч. назад`],
  [/^(\d+) days? ago$/, (m) => `${m[1]} дн. назад`],
  [/^(\d+(?:\.\d+)?)% used$/, (m) => `использовано ${m[1]}%`],
  [/^Resets in (.+)$/, (m) => `Сброс через ${ruDuration(m[1])}`],
  [/^Resets (.+)$/, (m) => `Сброс: ${m[1]}`],
  [/^(Weekly|Daily|Monthly|Five-hour|5-hour) · (.+)$/, (m) => `${({ Weekly: "Недельный", Daily: "Дневной", Monthly: "Месячный", "Five-hour": "5-часовой", "5-hour": "5-часовой" } as Record<string, string>)[m[1]]} · ${m[2]}`],
  [/^(\d+) day limit$/, (m) => `Лимит на ${m[1]} ${plural(+m[1], "день", "дня", "дней")}`],
  [/^(\d+)h limit$/, (m) => `Лимит на ${m[1]} ч`],
  [/^(\d+)d · (.+)$/, (m) => `${m[1]} д · ${m[2]}`],
];

const missing = new Set<string>();
try {
  for (const s of JSON.parse(localStorage.getItem(MISSING_KEY) ?? "[]")) missing.add(s);
} catch {}
let flushTimer: number | undefined;
function noteMissing(s: string) {
  if (missing.size >= 3000 || missing.has(s)) return;
  missing.add(s);
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    try { localStorage.setItem(MISSING_KEY, JSON.stringify([...missing])); } catch {}
  }, 2000);
}

function translate(raw: string): string | null {
  const text = raw.trim();
  if (!text || !/[A-Za-z]/.test(text)) return null;
  let out: string | undefined = DICT[text];
  if (out === undefined) {
    for (const [re, fn] of PATTERNS) {
      const m = text.match(re);
      if (m) { out = fn(m); break; }
    }
  }
  if (out === undefined) {
    if (text.length < 400) noteMissing(text);
    return null;
  }
  return raw.replace(text, out);
}

function handleText(node: Text) {
  const parent = node.parentElement;
  if (!parent || inSkipped(parent) || parent.isContentEditable) return;
  const cur = node.nodeValue ?? "";
  const res = translate(cur);
  if (res !== null && res !== cur) node.nodeValue = res;
}
function handleElement(el: Element) {
  if (inSkipped(el)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v) {
      const res = translate(v);
      if (res !== null && res !== v) el.setAttribute(a, res);
    }
  }
}
function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return handleText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  handleElement(el);
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = tw.nextNode())) {
    if (n.nodeType === Node.TEXT_NODE) handleText(n as Text);
    else handleElement(n as Element);
  }
}

// Brand / model names must never be machine-translated ("Fable" -> "Басня").
const PROTECTED = /\b(Fable|Opus|Sonnet|Haiku|Claude|Codex|Gemini|GPT|Grok|Cursor|Antigravity|OpenAI|Anthropic)\b/;
const cache = new Map<string, string>();
const isPluginPage = () => /^\/(settings(\/|$)|plugins(\/|$))/.test(window.location.pathname);

/** Floating button on plugin pages: translates the English text left on the page. */
function TranslateButton() {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [onPage, setOnPage] = useState(isPluginPage());
  useEffect(() => {
    const t = window.setInterval(() => setOnPage(isPluginPage()), 500);
    return () => window.clearInterval(t);
  }, []);
  if (!onPage) return null;
  const run = async () => {
    setBusy(true);
    try {
      const nodes: Text[] = [];
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = tw.nextNode())) {
        const t = n as Text;
        const p = t.parentElement;
        const v = (t.nodeValue ?? "").trim();
        if (!p || inSkipped(p) || p.closest("[data-ru-btn]")) continue;
        const words = v.match(/[A-Za-z]{2,}/g) ?? [];
        if (v.length >= 12 && words.length >= 3 && !PROTECTED.test(v) && !/[А-Яа-я@]/.test(v)) nodes.push(t);
      }
      const need = [...new Set(nodes.map((t) => t.nodeValue!.trim()).filter((v) => !cache.has(v)))];
      for (let i = 0; i < need.length; i += 40) {
        const part = need.slice(i, i + 40);
        const res = await rpc.call("translate", { texts: part });
        part.forEach((s, j) => cache.set(s, res.texts[j]));
      }
      for (const t of nodes) {
        const v = t.nodeValue!;
        const tr = cache.get(v.trim());
        if (tr) t.nodeValue = v.replace(v.trim(), tr);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      data-ru-btn=""
      onClick={run}
      disabled={busy}
      style={{
        position: "fixed", right: 20, bottom: 20, zIndex: 9999, padding: "8px 14px",
        borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", cursor: "pointer",
        background: "var(--background, #222)", color: "var(--foreground, #eee)", fontSize: 13,
      }}
    >
      {busy ? "Перевожу…" : "🌐 Перевести страницу"}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "ru-translate-btn", component: TranslateButton });
  app.contentScripts.register({
    id: "ru-translate",
    mount: ({ signal }) => {
      let pending: Node[] = [];
      let raf = 0;
      const observe = () =>
        observer.observe(document.body, {
          childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ATTRS,
        });
      const flush = () => {
        raf = 0;
        const batch = pending;
        pending = [];
        observer.disconnect();
        for (const n of batch) if (n.isConnected) walk(n);
        observe();
      };
      const observer = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "childList") m.addedNodes.forEach((n) => pending.push(n));
          else pending.push(m.target);
        }
        if (!raf) raf = requestAnimationFrame(flush);
      });
      walk(document.body);
      observe();
      const stop = () => {
        observer.disconnect();
        cancelAnimationFrame(raf);
      };
      signal.addEventListener("abort", stop);
      return stop;
    },
  });
});
