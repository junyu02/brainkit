import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import test from 'node:test';
import { chinesePhrases, scoreEntryRelevance, tokenizeQuery } from '../scripts/cli/brain-query.mjs';
import { evaluateRetrieval, rankNotes } from '../scripts/lib/memory-retrieval.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/memory-retrieval-eval.json', import.meta.url), 'utf8'));
const allQueries = [...fixture.train, ...fixture.validation];
// Frozen 09f1abf rankNotes baseline, retained only to make this synthetic comparison reproducible.
const baselineRank = (notes, query, limit = 20) => {
  const terms = tokenizeQuery(query), grams = chinesePhrases(query);
  return notes.map(note => ({ note, score: scoreEntryRelevance(note.title, terms, grams).score * 3 + scoreEntryRelevance(note.description + '\n' + note.body, terms, grams).score }))
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.note.id.localeCompare(b.note.id)).slice(0, limit);
};

test('synthetic retrieval slice improves aliases and keeps frozen validation above targets', () => {
  const baseline = evaluateRetrieval(fixture.notes, allQueries, baselineRank);
  const enhanced = evaluateRetrieval(fixture.notes, allQueries);
  const train = evaluateRetrieval(fixture.notes, fixture.train);
  const validation = evaluateRetrieval(fixture.notes, fixture.validation);
  assert.equal(allQueries.length, 40);
  assert.match(fixture.notice, /合成/);
  assert.ok(validation.recallAt3 >= 0.9, `validation Recall@3=${validation.recallAt3}`);
  assert.ok(validation.mrr >= 0.8, `validation MRR=${validation.mrr}`);
  assert.ok(train.recallAt3 >= 0.9 && train.mrr >= 0.8);
  assert.ok(enhanced.recallAt3 > baseline.recallAt3);
  assert.ok(enhanced.mrr > baseline.mrr);
});

test('aliases and same-name entities rank the intended notes without query-specific rules', () => {
  assert.equal(rankNotes(fixture.notes, '谁接手 A-Workspace 的权限复核', 1)[0].note.id, '01-项目/Atlas/交接.md');
  assert.equal(rankNotes(fixture.notes, '北极星的访谈计划不是功能灰度', 1)[0].note.id, '02-知识/研究/北极星实验.md');
  assert.equal(baselineRank(fixture.notes, '谁接手 A-Workspace 的权限复核', 3).some(row => row.note.id === '01-项目/Atlas/交接.md'), false);
});

test('public documentation regression retains frozen natural questions and reports cross-language limits', () => {
  const data = fixture.public_document_eval;
  const notes = data.source_documents.map(id => {
    const body = readFileSync(new URL('../' + id, import.meta.url), 'utf8');
    return { id, title: basename(id), description: body.split('\n').find(line => line.startsWith('# '))?.slice(2) || '', body };
  });
  const questions = data.questions.map(row => ({ question: row.question, expected_id: row.expected_document }));
  const baseline = evaluateRetrieval(notes, questions, baselineRank), current = evaluateRetrieval(notes, questions);
  assert.equal(questions.length, 12);
  assert.ok(current.recallAt3 >= baseline.recallAt3);
  assert.ok(current.mrr >= baseline.mrr);
  assert.ok(current.recallAt3 >= 0.9);
});
