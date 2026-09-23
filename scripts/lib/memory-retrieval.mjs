import { chinesePhrases, scoreEntryRelevance, tokenizeQuery } from '../cli/brain-query.mjs';

const text = value => typeof value === 'string' ? value : '';
const aliasesFor = note => Array.isArray(note.meta?.aliases) ? note.meta.aliases.filter(value => typeof value === 'string') : [];
const scoreField = (value, terms, grams) => scoreEntryRelevance(text(value), terms, grams).score;
const cjkBigrams = query => [...new Set((query.match(/[\u3400-\u9fff]{2,}/gu) || []).flatMap(run => Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2)).filter(term => !/[的是在了和与或及对从到为]/u.test(term))))];
const negativeTerms = query => (query.match(/(?:不是|不含|不包括)\s*([^，。！？；]+)/u) || [])[1]?.split('的')[0] || '';

// Callers own trust and active-note filtering; this ranks the supplied notes only.
export function rankNotes(notes, query, limit = 20) {
  const excluded = negativeTerms(query);
  const positiveQuery = excluded ? query.replace(excluded, '') : query;
  const terms = [...new Set([...tokenizeQuery(positiveQuery), ...cjkBigrams(positiveQuery)])];
  const grams = chinesePhrases(positiveQuery);
  const negative = excluded ? [...new Set([...tokenizeQuery(excluded), ...cjkBigrams(excluded)])] : [];
  const negativeGrams = excluded ? chinesePhrases(excluded) : new Set();
  return notes.map(note => {
    const title = scoreField(note.title, terms, grams);
    const description = scoreField(note.description, terms, grams);
    const body = scoreField(note.body, terms, grams) / (1 + Math.log2(Math.max(1, text(note.body).length / 500)));
    const aliases = scoreField(aliasesFor(note).join('\n'), terms, grams);
    const id = scoreField(note.id, terms, grams);
    const joined = [note.title, note.description, note.body, ...aliasesFor(note), note.id].join('\n');
    // Prefer explicit names without repeatedly rewarding the same terms in title, path, and body.
    return { note, score: title * 3 + description * 1.5 + body + aliases * 2 + id * 0.25 - scoreField(joined, negative, negativeGrams) * 2 };
  }).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.note.id.localeCompare(b.note.id))
    .slice(0, limit);
}

export function evaluateRetrieval(notes, queries, rank = rankNotes, limit = 3) {
  const positions = queries.map(({ expected_id, question }) => rank(notes, question, limit).findIndex(row => row.note.id === expected_id) + 1);
  return {
    queries: queries.length,
    recallAt3: positions.filter(position => position > 0).length / queries.length,
    mrr: positions.reduce((sum, position) => sum + (position ? 1 / position : 0), 0) / queries.length,
    positions,
  };
}
