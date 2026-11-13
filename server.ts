// bb-plugin-ru — backend: translates plugin-page text on demand (button in the UI).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  translate: {
    input: z.object({ texts: z.array(z.string().max(2000)).max(200) }),
    output: z.object({ texts: z.array(z.string()) }),
  },
});

async function viaGoogle(text: string, signal: AbortSignal): Promise<string> {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=en&tl=ru&dt=t&q=" +
    encodeURIComponent(text);
  const res = await fetch(url, { signal, headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`google ${res.status}`);
  const data = (await res.json()) as unknown[][][];
  return data[0].map((p) => String(p[0] ?? "")).join("");
}

async function viaMyMemory(text: string, signal: AbortSignal): Promise<string> {
  const url =
    "https://api.mymemory.translated.net/get?langpair=en|ru&q=" + encodeURIComponent(text.slice(0, 480));
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`mymemory ${res.status}`);
  const data = (await res.json()) as { responseData?: { translatedText?: string } };
  const out = data.responseData?.translatedText;
  if (!out) throw new Error("mymemory empty");
  return out;
}

async function translateOne(text: string, signal: AbortSignal): Promise<string> {
  const fix = (s: string) => s.replace(/потоки|потоков|потоках/g, (m) => ({ потоки: "треды", потоков: "тредов", потоках: "тредах" })[m]!);
  try {
    return fix(await viaGoogle(text, signal));
  } catch {
    try {
      return fix(await viaMyMemory(text, signal));
    } catch {
      return text;
    }
  }
}

export default function (bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    translate: async ({ texts }, ctx) => {
      const out: string[] = new Array(texts.length);
      let next = 0;
      const worker = async () => {
        while (next < texts.length) {
          const i = next++;
          out[i] = await translateOne(texts[i], ctx.experimental_signal);
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      return { texts: out };
    },
  });
  return {};
}
