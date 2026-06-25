import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestTextbook } from './curriculum.js';
import { CURRICULUM_DIR } from './paths.js';
/**
 * 课程知识库 seed：读取 curriculum/*.json（每文件为一册 TextbookSeed 或其数组），
 * 逐册入库并计算 embedding。运行：npm run seed:curriculum --workspace @boen/server
 * 幂等：同一册重复运行会先清后写。
 */
async function main() {
    let files = [];
    try {
        files = readdirSync(CURRICULUM_DIR).filter((f) => f.endsWith('.json'));
    }
    catch {
        console.error(`找不到课程数据目录：${CURRICULUM_DIR}`);
        process.exit(1);
    }
    if (files.length === 0) {
        console.warn(`${CURRICULUM_DIR} 下没有 .json 课程数据`);
        return;
    }
    console.log(`课程数据目录：${CURRICULUM_DIR}，共 ${files.length} 个文件`);
    let totalUnits = 0;
    let totalKps = 0;
    for (const file of files) {
        const raw = JSON.parse(readFileSync(join(CURRICULUM_DIR, file), 'utf-8'));
        const books = Array.isArray(raw) ? raw : [raw];
        for (const book of books) {
            const { units, kps } = await ingestTextbook(book);
            totalUnits += units;
            totalKps += kps;
            console.log(`  ✓ ${file}: ${book.subject} ${book.grade}年级 ${book.volume ?? '全册'} → ${units} 章节 / ${kps} 知识点`);
        }
    }
    console.log(`完成：共写入 ${totalUnits} 章节、${totalKps} 知识点，并已生成向量。`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
