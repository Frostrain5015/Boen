export const EXTERNAL_SOURCES = {
  marble: {
    name: 'Marble Skill Taxonomy',
    url: 'https://github.com/withmarbleapp/os-taxonomy',
    license: 'ODbL 1.0（数据库）/ CC BY-SA 4.0（原创文字）',
    credit: '© Generative Spark, Inc. (Marble)',
    commercial: true,
    files: ['topics.json', 'dependencies.json'],
  },
  'k12-kgraph': {
    name: 'K12-KGraph',
    url: 'https://huggingface.co/datasets/lhpku20010120/K12-KGraph',
    license: 'CC BY-NC-SA 4.0',
    credit: 'Hao Liang et al.',
    commercial: false,
    files: ['nodes.json', 'edges.json'],
  },
  'cn-math-taxonomy': {
    name: 'cn-math-taxonomy',
    url: 'https://github.com/xiaoyang111222/cn-math-taxonomy',
    license: 'CC BY-NC 4.0',
    credit: 'xiaoyang111222',
    commercial: false,
    files: ['topics.json', 'dependencies.json'],
  },
} as const;

export type ExternalSource = keyof typeof EXTERNAL_SOURCES;
export const externalSourceKeys = Object.keys(EXTERNAL_SOURCES) as ExternalSource[];
export const isExternalSource = (key: string): key is ExternalSource => Object.hasOwn(EXTERNAL_SOURCES, key);

export interface ExternalTopic {
  id: string;
  title: string;
  description: string;
  subject: string;
  firstGrade: number | null;
  lastGrade: number | null;
  kind: string;
  chapter: string;
}

export interface ExternalRelation {
  from: string;
  to: string;
  type: string;
  strength: 'hard' | 'soft' | null;
}

export interface ExternalGraph {
  topics: ExternalTopic[];
  relations: ExternalRelation[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

function records(value: unknown, key: string): unknown[] {
  const rows = Array.isArray(value) ? value : object(value)[key];
  if (!Array.isArray(rows) || !rows.length) throw new Error(`Missing or empty ${key} array`);
  return rows;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function required(value: unknown, field: string): string {
  const str = text(value);
  if (!str) throw new Error(`Missing ${field}`);
  return str;
}

function integer(value: unknown): number | null {
  const n = typeof value === 'number' ? value : /^[0-9]+$/.test(text(value)) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

const MARBLE_SUBJECTS: Record<string, string> = { Mathematics: 'math', Science: 'science', English: 'english' };

function marbleTopic(row: Record<string, unknown>): ExternalTopic {
  const subject = required(row.subject, 'subject');
  const start = integer(row.ageRangeStart);
  const end = integer(row.ageRangeEnd);
  return {
    id: required(row.id, 'id'),
    title: required(row.name, 'name'),
    description: text(row.description),
    subject: MARBLE_SUBJECTS[subject] ?? subject,
    firstGrade: start === null ? null : Math.max(1, start - 5),
    lastGrade: end === null ? null : Math.min(6, end - 5),
    kind: 'topic',
    chapter: '',
  };
}

function cnTopic(row: Record<string, unknown>): ExternalTopic {
  const grade = integer(row.grade);
  const id = required(row.id, 'id');
  return {
    id,
    title: required(row.name, 'name'),
    description: text(row.description),
    subject: text(row.subject) || (/^cnm(?:_|p)/.test(id) ? 'math' : ''),
    firstGrade: grade,
    lastGrade: grade,
    kind: 'topic',
    chapter: text(row.chapter),
  };
}

function k12Topic(row: Record<string, unknown>): ExternalTopic {
  const id = required(row.id, 'id');
  const [subject, book] = id.split('_', 2);
  const grade = integer(book?.match(/^(\d+)[ab]?$/)?.[1]);
  return {
    id,
    title: required(row.name, 'name'),
    description: text(row.definition) || text(row.properties && object(row.properties).definition),
    subject,
    firstGrade: grade,
    lastGrade: grade,
    kind: required(row.label, 'label').toLowerCase(),
    chapter: '',
  };
}

export function normalizeExternalGraph(source: ExternalSource, rawTopics: unknown, rawRelations: unknown, k12Details: unknown[] = []): ExternalGraph {
  const parseTopic = source === 'marble' ? marbleTopic : source === 'k12-kgraph' ? k12Topic : cnTopic;
  const topics = records(rawTopics, source === 'k12-kgraph' ? 'nodes' : 'topics').map(row => parseTopic(object(row)));
  const byId = new Map<string, ExternalTopic>();
  for (const topic of topics) {
    if (byId.has(topic.id)) throw new Error(`Duplicate topic ID: ${topic.id}`);
    byId.set(topic.id, topic);
  }
  for (const detail of k12Details) {
    for (const value of records(detail, 'nodes')) {
      const row = object(value);
      const topic = byId.get(text(row.id));
      if (topic && !topic.description && row.properties) topic.description = text(object(row.properties).definition);
    }
  }
  const relations = new Map<string, ExternalRelation>();
  for (const value of records(rawRelations, source === 'k12-kgraph' ? 'edges' : 'dependencies')) {
    const row = object(value);
    const k12 = source === 'k12-kgraph';
    const from = required(k12 ? row.source : row.prerequisiteId, 'source');
    const to = required(k12 ? row.target : row.topicId, 'target');
    const rawType = k12 ? required(row.type, 'relation type') : 'prerequisite';
    const type = rawType === 'prerequisites_for' ? 'prerequisite' : rawType;
    if (!byId.has(from) || !byId.has(to)) throw new Error(`Unknown endpoint: ${from} → ${to}`);
    if (from === to && type === 'prerequisite') throw new Error(`Self prerequisite: ${from}`);
    const strength = row.strength === 'hard' || row.strength === 'soft' ? row.strength : null;
    const key = JSON.stringify([from, to, type]);
    if (relations.has(key) && relations.get(key)?.strength !== strength) {
      throw new Error(`Conflicting prerequisite strength: ${from} → ${to}`);
    }
    relations.set(key, { from, to, type, strength });
  }
  const edges = [...relations.values()];
  checkPrerequisiteCycles(topics, edges);
  return { topics, relations: edges };
}

function checkPrerequisiteCycles(topics: ExternalTopic[], relations: ExternalRelation[]): void {
  const incoming = new Map(topics.map(topic => [topic.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.type !== 'prerequisite' || relation.strength === 'soft') continue;
    const list = outgoing.get(relation.from) ?? [];
    list.push(relation.to);
    outgoing.set(relation.from, list);
    incoming.set(relation.to, incoming.get(relation.to)! + 1);
  }
  const queue = topics.filter(topic => incoming.get(topic.id) === 0).map(topic => topic.id);
  for (let i = 0; i < queue.length; i++) {
    for (const target of outgoing.get(queue[i]) ?? []) {
      const count = incoming.get(target)! - 1;
      incoming.set(target, count);
      if (count === 0) queue.push(target);
    }
  }
  if (queue.length !== topics.length) throw new Error('Cycle in required prerequisite relations');
}
