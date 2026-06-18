import Database from 'better-sqlite3';
import { join } from 'node:path';
const db = new Database(join(process.cwd(), 'data', 'boen.db'));
db.pragma('journal_mode = WAL');

const tb = db.prepare(`SELECT * FROM curriculum_textbooks WHERE subject='math' AND grade='7' AND volume='上册'`).get() as any;
console.log('教材:', tb.version);
console.log('来源:', tb.source_url);
console.log('');

const chapters = db.prepare(`SELECT * FROM curriculum_units WHERE textbook_id=? AND parent_id IS NULL ORDER BY seq`).all(tb.id) as any[];
for (const ch of chapters) {
  console.log('■', ch.title);
  const sections = db.prepare(`SELECT * FROM curriculum_units WHERE parent_id=? ORDER BY seq`).all(ch.id) as any[];
  for (const sec of sections) {
    const kps = db.prepare(`
      SELECT kp.title FROM unit_knowledge_map ukm
      JOIN knowledge_points kp ON kp.id = ukm.knowledge_point_id
      WHERE ukm.unit_id=?
    `).all(sec.id) as any[];
    const kpStr = kps.length ? '  → [' + kps.map((k: any) => k.title).join(', ') + ']' : '';
    const subCount = (db.prepare(`SELECT COUNT(*) AS n FROM curriculum_units WHERE parent_id=?`).get(sec.id) as any).n;
    const hasSub = subCount > 0;
    console.log('  ├', sec.title, hasSub ? `(${subCount} 子节)` : '', kpStr);
    if (hasSub) {
      const subs = db.prepare(`SELECT * FROM curriculum_units WHERE parent_id=? ORDER BY seq`).all(sec.id) as any[];
      for (const sub of subs) {
        const subkps = db.prepare(`
          SELECT kp.title FROM unit_knowledge_map ukm
          JOIN knowledge_points kp ON kp.id = ukm.knowledge_point_id
          WHERE ukm.unit_id=?
        `).all(sub.id) as any[];
        const subkpStr = subkps.length ? '  → [' + subkps.map((k: any) => k.title).join(', ') + ']' : '';
        console.log('    ╰', sub.title, subkpStr);
      }
    }
  }
}

console.log('\n=== 知识图谱关联（通过 curriculum_kg_map） ===');
const maps = db.prepare(`
  SELECT n.type, n.title, n.code, m.relevance
  FROM curriculum_kg_map m
  JOIN kg_nodes n ON n.id = m.node_id
  JOIN curriculum_units u ON u.id = m.unit_id
  JOIN curriculum_textbooks t ON t.id = u.textbook_id
  WHERE t.subject='math' AND t.grade='7' AND t.volume='上册'
  GROUP BY n.id
  ORDER BY n.type, n.code
`).all() as any[];

const grouped: Record<string, any[]> = {};
for (const m of maps) {
  if (!grouped[m.type]) grouped[m.type] = [];
  grouped[m.type].push(m);
}
for (const [type, nodes] of Object.entries(grouped)) {
  console.log(`\n[${type}] ${nodes.length} 个`);
  for (const n of nodes as any[]) {
    console.log(`  ${n.code ? n.code+' ' : ''}${n.title} (${n.relevance})`);
  }
}

// 展示最核心的功能：从章节能"看到"哪些素养
console.log('\n=== 第一章 有理数 → 追溯素养链 ===');
const firstCh = chapters[0];
const firstUnit = db.prepare(`SELECT id FROM curriculum_units WHERE parent_id=? ORDER BY seq LIMIT 1`).get(firstCh.id) as any;
if (firstUnit) {
  const context = db.prepare(`
    SELECT n.type, n.title, n.code, m.relevance
    FROM curriculum_kg_map m
    JOIN kg_nodes n ON n.id = m.node_id
    WHERE m.unit_id=?
    ORDER BY m.relevance DESC
  `).all(firstUnit.id) as any[];
  console.log(`小节 ${firstCh.title} / 1.1 正数和负数 关联的 KG 节点：`);
  for (const c of context) {
    console.log(`  [${c.type}] ${c.title}`);
    // 再跳一步：素养的上级
    const parents = db.prepare(`
      SELECT n2.title, e.type AS edge_type
      FROM kg_edges e
      JOIN kg_nodes n2 ON n2.id = e.target_id
      WHERE e.source_id=(SELECT id FROM kg_nodes WHERE type=? AND title=?)
    `).all(c.type, c.title) as any[];
    for (const p of parents) {
      console.log(`    ╰ ${p.edge_type} → ${p.title}`);
    }
  }
}

db.close();
