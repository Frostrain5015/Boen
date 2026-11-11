import { describe, expect, it } from 'vitest';
import { normalizeExternalGraph } from '../external-curriculum-formats.js';
import { externalSearchTerms, isSearchableExternalTopic } from '../external-curriculum.js';

describe('external curriculum data', () => {
  const marbleTopics = [
    { id: 'a', name: 'Fixture prerequisite', subject: 'Mathematics', ageRangeStart: 6, ageRangeEnd: 9 },
    { id: 'b', name: 'Fixture skill', subject: 'Mathematics', ageRangeStart: 9, ageRangeEnd: 13 },
  ];
  const marbleEdge = { topicId: 'b', prerequisiteId: 'a', strength: 'hard' };

  it('reads Marble envelopes and preserves the direction and strength of dependencies', () => {
    const graph = normalizeExternalGraph('marble', { topics: marbleTopics }, { dependencies: [marbleEdge] });
    expect(graph.relations).toEqual([{ from: 'a', to: 'b', type: 'prerequisite', strength: 'hard' }]);
    expect(graph.topics[1]).toMatchObject({ subject: 'math', firstGrade: 4, lastGrade: 6 });
  });

  it('reads Chinese curriculum arrays and recognizes legacy math IDs without a subject field', () => {
    const graph = normalizeExternalGraph('cn-math-taxonomy', [
      { id: 'cnm_0001', name: '测试甲', grade: 7, chapter: '测试章' },
      { id: 'cnm_0002', name: '测试乙', grade: '8' },
    ], [{ topicId: 'cnm_0002', prerequisiteId: 'cnm_0001', strength: 'soft' }]);
    expect(graph.topics[0]).toMatchObject({ subject: 'math', firstGrade: 7, chapter: '测试章' });
    expect(graph.relations[0]).toMatchObject({ from: 'cnm_0001', to: 'cnm_0002', strength: 'soft' });
    expect(externalSearchTerms('测试甲 Fraction')).toEqual(['测试', '试甲', 'fraction']);
  });

  it('preserves typed K12 relations and adds subject-specific definitions by ID', () => {
    const chapter = 'physics_9_rjb_chp1';
    const concept = 'physics_9_rjb_cpt1';
    const graph = normalizeExternalGraph('k12-kgraph', [
      { id: chapter, name: '测试章', label: 'Chapter' },
      { id: concept, name: '测试概念', label: 'Concept' },
    ], [
      { source: concept, target: chapter, type: 'appears_in' },
    ], [{ nodes: [{ id: concept, properties: { definition: '测试定义' } }] }]);
    expect(graph.topics[1]).toMatchObject({ subject: 'physics', firstGrade: 9, description: '测试定义' });
    expect(graph.relations[0]).toMatchObject({ type: 'appears_in', from: concept, to: chapter });
    expect(graph.topics.map(isSearchableExternalTopic)).toEqual([false, true]);
  });

  it('rejects dangling endpoints and cycles in required prerequisites', () => {
    expect(() => normalizeExternalGraph('marble', marbleTopics, [{ ...marbleEdge, topicId: 'missing' }]))
      .toThrow('Unknown endpoint');
    expect(() => normalizeExternalGraph('marble', marbleTopics, [
      marbleEdge, { topicId: 'a', prerequisiteId: 'b', strength: 'hard' },
    ])).toThrow('Cycle');
  });
});
