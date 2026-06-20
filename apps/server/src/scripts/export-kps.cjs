const db = require('better-sqlite3')('./data/boen.db');
const fs = require('fs');
const subjects = ['chinese', 'english', 'science'];
const output = {};

for (const s of subjects) {
  const rows = db.prepare(
    `SELECT DISTINCT n.id, n.title, t.grade
     FROM kg_nodes n
     JOIN curriculum_kg_map m ON m.node_id = n.id
     JOIN curriculum_units u ON u.id = m.unit_id
     JOIN curriculum_textbooks t ON t.id = u.textbook_id
     WHERE n.type='knowledge_point' AND n.subject=?
     ORDER BY t.grade, n.id`
  ).all(s);

  output[s] = {};
  for (const r of rows) {
    if (!output[s][r.grade]) output[s][r.grade] = [];
    output[s][r.grade].push({ id: r.id, title: r.title });
  }
  for (const g of Object.keys(output[s]).sort()) {
    console.log(`${s} G${g}: ${output[s][g].length} KPs`);
  }
}

fs.writeFileSync('../../kp-export.json', JSON.stringify(output, null, 2));
db.close();
console.log('\nExported to kp-export.json');
