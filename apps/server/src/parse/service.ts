import type { ShopConfig } from '../shop/config.js'

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{M}\p{N}_]+|\+/gu) ?? []
}

function matchesWord(word: string | undefined, synonym: string): boolean {
  if (word === synonym) return true
  if (
    !word ||
    !/^\p{L}{5,}$/u.test(word) ||
    !/^\p{L}{5,}$/u.test(synonym) ||
    Math.abs(word.length - synonym.length) > 1
  ) {
    return false
  }

  // After the common prefix, at most one insertion, deletion or substitution is allowed.
  const [shorter, longer] =
    word.length <= synonym.length ? [word, synonym] : [synonym, word]
  let i = 0
  while (i < shorter.length && shorter[i] === longer[i]) i++
  const suffix =
    shorter.length === longer.length ? shorter.slice(i + 1) : shorter.slice(i)
  return suffix === longer.slice(i + 1)
}

export function matchService(
  text: string,
  services: ShopConfig['services'],
): { id: string; inferred: boolean } | undefined {
  const words = tokenize(text)
  let best: { id: string; inferred: boolean } | undefined
  let longest = 0

  for (const service of services) {
    for (const synonym of service.synonyms) {
      const phrase = tokenize(synonym)
      const joined = phrase.join('')
      if (!joined || joined.length < longest) continue

      const exact = words.some((_, start) =>
        phrase.every((part, i) => words[start + i] === part),
      )
      if (joined.length === longest && !(best?.inferred && exact)) continue

      const allowJoined = phrase.length > 1 && !phrase.includes('+')
      if (
        exact ||
        words.some(
          (word, start) =>
            (allowJoined && matchesWord(word, joined)) ||
            phrase.every((part, i) => matchesWord(words[start + i], part)),
        )
      ) {
        longest = joined.length
        best = { id: service.id, inferred: !exact }
      }
    }
  }
  return best
}
