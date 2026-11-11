import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { MULTILINGUAL_EMBEDDING_MODEL, embedTexts, vectorToBlob } from '../embeddings.js';
import { EXTERNAL_SOURCES, isExternalSource, normalizeExternalGraph } from '../external-curriculum-formats.js';
import {
  EXTERNAL_CATALOG_DIR, EXTERNAL_CATALOG_SCHEMA, externalCatalogPath, externalEmbeddingModel, externalSearchTerms, isSearchableExternalTopic,
} from '../external-curriculum.js';

async function main() {
  const { positionals: [key, revision, input, ...extra], values } = parseArgs({
    allowPositionals: true,
    options: {
      authorization: { type: 'string' },
      'output-dir': { type: 'string' },
      'no-vectors': { type: 'boolean' },
    },
  });
  if (!key || !isExternalSource(key) || !revision?.trim() || !input || extra.length) {
    throw new Error('Usage: import:external-curriculum -- <source> <revision> <input-dir> [--authorization <reference>] [--output-dir <directory>] [--no-vectors]');
  }
  const source = EXTERNAL_SOURCES[key];
  const authorization = source.commercial ? null : values.authorization?.trim() || null;
  if (!source.commercial && !authorization) throw new Error(`${source.name} 的公开许可为 ${source.license}。商用导入需提供另行授权的记录编号。`);

  const k12Root = key === 'k12-kgraph' && existsSync(join(input, 'global_KG', 'nodes.json'));
  const read = (name: string) => ({ name, bytes: readFileSync(join(input, name)) });
  const parse = ({ bytes }: { bytes: Buffer }) => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as unknown;
  const rawFiles = source.files.map(name => read(k12Root ? `global_KG/${name}` : name));
  const [rawTopics, rawEdges] = rawFiles.map(parse);
  const details = k12Root
    ? ['math', 'physics', 'chemistry', 'biology'].map(subject => `subject_specific_KG/${subject}.json`)
      .filter(name => existsSync(join(input, name))).map(read)
    : [];
  const graph = normalizeExternalGraph(key, rawTopics, rawEdges, details.map(parse));
  rawFiles.push(...details);
  if (key === 'marble') {
    for (const name of ['LICENSE', 'LICENSE-CONTENT', 'PROVENANCE.md']) {
      rawFiles.push(read(name));
    }
  }

  const directory = resolve(values['output-dir'] ?? EXTERNAL_CATALOG_DIR);
  mkdirSync(directory, { recursive: true });
  const destination = externalCatalogPath(key, directory);
  const staging = `${destination}.${randomUUID()}.tmp`;
  const catalog = new Database(staging);
  const searchable = graph.topics.filter(isSearchableExternalTopic);
  const searchableIds = new Set(searchable.map(topic => topic.id));
  const model = values['no-vectors'] ? null : externalEmbeddingModel(key);
  try {
    catalog.pragma('foreign_keys = ON');
    catalog.pragma(`user_version = ${EXTERNAL_CATALOG_SCHEMA}`);
    catalog.exec(`
      CREATE TABLE dataset (source TEXT PRIMARY KEY, version TEXT NOT NULL, attribution TEXT NOT NULL,
        license TEXT NOT NULL, url TEXT NOT NULL, model TEXT, authorization TEXT);
      CREATE TABLE source_files (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, content BLOB NOT NULL);
      CREATE TABLE topics (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, subject TEXT NOT NULL,
        first_grade INTEGER, last_grade INTEGER, kind TEXT NOT NULL, chapter TEXT NOT NULL,
        searchable INTEGER NOT NULL, embedding BLOB);
      CREATE INDEX topic_scope ON topics (subject, searchable, first_grade, last_grade);
      CREATE TABLE relations (
        source_id TEXT NOT NULL REFERENCES topics(id), target_id TEXT NOT NULL REFERENCES topics(id),
        type TEXT NOT NULL, strength TEXT, PRIMARY KEY(source_id,target_id,type)
      );
      CREATE INDEX relation_target ON relations (target_id, type);
      CREATE VIRTUAL TABLE topic_search USING fts5(topic_id UNINDEXED, title, description, tokenize='unicode61');
    `);
    const saveFile = catalog.prepare('INSERT INTO source_files VALUES (?,?,?)');
    const saveTopic = catalog.prepare('INSERT INTO topics VALUES (?,?,?,?,?,?,?,?,?,NULL)');
    const saveRelation = catalog.prepare('INSERT INTO relations VALUES (?,?,?,?)');
    const indexTopic = catalog.prepare('INSERT INTO topic_search VALUES (?,?,?)');
    catalog.transaction(() => {
      catalog.prepare('INSERT INTO dataset VALUES (?,?,?,?,?,?,?)').run(
        key, revision, source.credit, source.license, source.url, model, authorization,
      );
      for (const { name, bytes } of rawFiles) saveFile.run(name, createHash('sha256').update(bytes).digest('hex'), bytes);
      for (const topic of graph.topics) {
        const eligible = searchableIds.has(topic.id);
        saveTopic.run(topic.id, topic.title, topic.description, topic.subject, topic.firstGrade, topic.lastGrade, topic.kind, topic.chapter, eligible ? 1 : 0);
        if (eligible) indexTopic.run(topic.id, externalSearchTerms(topic.title).join(' '), externalSearchTerms(topic.description).join(' '));
      }
      for (const relation of graph.relations) saveRelation.run(relation.from, relation.to, relation.type, relation.strength);
    })();
    if (model) {
      const writeVector = catalog.prepare('UPDATE topics SET embedding=? WHERE id=?');
      for (let i = 0; i < searchable.length; i += 24) {
        const batch = searchable.slice(i, i + 24);
        const prefix = model === MULTILINGUAL_EMBEDDING_MODEL ? 'passage: ' : '';
        const vectors = await embedTexts(batch.map(topic => `${prefix}${topic.title}\n${topic.description}`), model);
        if (vectors.length !== batch.length || vectors.some(vector => !vector.length || vector.some(value => !Number.isFinite(value)))) {
          throw new Error('Invalid embedding batch');
        }
        catalog.transaction(() => batch.forEach((topic, index) => writeVector.run(vectorToBlob(vectors[index]), topic.id)))();
        if (i % 240 === 0) console.log(`已生成 ${i + batch.length}/${searchable.length} 个向量`);
      }
    }
    if (catalog.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Catalog integrity check failed');
    catalog.close();
    renameSync(staging, destination);
    console.log(JSON.stringify({
      source: key, revision, topics: graph.topics.length, relations: graph.relations.length,
      prerequisites: graph.relations.filter(relation => relation.type === 'prerequisite').length,
      searchable: searchable.length, embeddings: model ? searchable.length : 0, destination,
    }, null, 2));
  } finally {
    if (catalog.open) catalog.close();
    rmSync(staging, { force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
