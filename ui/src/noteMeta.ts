// Title and tags from the content of a note. A model proposes them when one is available; this module is the fallback that works
// instantly and offline (first heading or sentence for the title, most characteristic words for the tags) and the validator for the model's answer.

const STOP = new Set(("и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам сказал ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это который которая которые которых также являются является может могут были быть имеет имеют году года годы годов других другие такие такое такая тоже свои своей своих ")
  .split(/\s+/).concat("the of and to in is that for it as with was on are by this be at from or an have not but they which one you all were her she there their will would can has had its into more other than then them these some such only also may been most over any about after both between each".split(" ")));

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** The first heading of the note or, failing that, the start of the first sentence: at most 60 characters, no final full stop. */
export function suggestTitle(texts: Array<{ heading?: boolean; text: string }>): string {
  const heading = texts.find((t) => t.heading && clean(t.text).length >= 3);
  const source = heading ? clean(heading.text) : clean(texts.find((t) => clean(t.text).length > 0)?.text ?? "");
  if (!source) return "";
  let title = heading ? source : source.split(/(?<=[.!?…])\s/)[0];
  title = title.replace(/[.!?…:;,\s]+$/, "");
  if (title.length > 60) {
    const cut = title.slice(0, 60);
    title = cut.slice(0, Math.max(cut.lastIndexOf(" "), 30)).replace(/[,;:\s]+$/, "") + "…";
  }
  return title;
}

const stem = (word: string) => word.replace(/(ами|ями|ов|ев|ей|ом|ем|ам|ям|ах|ях|ой|ый|ий|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ых|их|ую|юю|ть|ся|а|я|у|ю|ы|и|е|о)$/u, "");

/** The most characteristic words: frequent, not common, at least five letters; one form per stem (the most frequent spelling). */
export function suggestTags(text: string, limit = 5): string[] {
  const counts = new Map<string, { count: number; forms: Map<string, number> }>();
  for (const raw of text.toLowerCase().match(/[a-zа-яё][a-zа-яё-]{3,}/giu) ?? []) {
    if (STOP.has(raw) || raw.length < 5) continue;
    const key = stem(raw);
    if (key.length < 4) continue;
    const entry = counts.get(key) ?? { count: 0, forms: new Map() };
    entry.count += 1;
    entry.forms.set(raw, (entry.forms.get(raw) ?? 0) + 1);
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || [...b.forms.keys()][0].length - [...a.forms.keys()][0].length)
    .filter((entry) => entry.count >= 2)
    .slice(0, limit)
    .map((entry) => [...entry.forms.entries()].sort((a, b) => b[1] - a[1])[0][0]);
}

/** Reads a model's answer ({"title": "...", "tags": [...]}, possibly in a code fence). Returns null when it is unusable. */
export function parseMetaAnswer(answer: string): { title: string; tags: string[] } | null {
  const match = /\{[\s\S]*\}/.exec(answer.replace(/```(?:json)?/gi, ""));
  if (!match) return null;
  try {
    const data = JSON.parse(match[0]) as { title?: unknown; tags?: unknown };
    const title = typeof data.title === "string" ? clean(data.title).replace(/[.\s]+$/, "").replace(/^["«]+|["»]+$/g, "").replace(/[.\s]+$/, "") : "";
    const tags = Array.isArray(data.tags)
      ? [...new Set(data.tags.filter((t): t is string => typeof t === "string").map((t) => clean(t).toLowerCase().replace(/^#/, "")).filter((t) => t.length >= 2 && t.length <= 30 && !/[,;]/.test(t)))].slice(0, 6)
      : [];
    if (title.length < 3 || title.length > 100) return null;
    return { title, tags };
  } catch {
    return null;
  }
}

export const META_INSTRUCTION =
  'Прочитай текст и предложи название и теги. Верни только JSON такой формы: {"title":"…","tags":["…"]}. Название: до 8 слов, отражает главную мысль, без кавычек и точки. Теги: от 3 до 5, в нижнем регистре, одно-два слова, существительные по теме текста. Язык названия и тегов — язык текста.';
