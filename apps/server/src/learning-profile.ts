import type Database from 'better-sqlite3';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { GRADES, isGrade, type Grade, type LearningProfile } from '@boen/shared';

export const GRADE_REQUIRED = { error: 'grade_required', message: '请先选择你的年级' } as const;

export function initLearningProfiles(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_learning_profiles (
      user_id TEXT PRIMARY KEY NOT NULL,
      grade TEXT NOT NULL CHECK (grade IN (${GRADES.map(grade => `'${grade}'`).join(', ')}))
    );
  `);
}

export function getLearningGrade(db: Database.Database, userId: string): Grade | null {
  const grade = db.prepare('SELECT grade FROM user_learning_profiles WHERE user_id=?').pluck().get(userId);
  return isGrade(grade) ? grade : null;
}

const gradeUpdate = z.object({ grade: z.enum(GRADES) }).strict();

export function learningProfileRoutes(db: Database.Database, resolveUserId: (c: Context) => Promise<string | null>) {
  const routes = new Hono();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.get('/', async c => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unauthorized' }, 401);
    return c.json<LearningProfile>({ grade: getLearningGrade(db, userId) });
  });
  routes.put('/', async c => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unauthorized' }, 401);
    const parsed = gradeUpdate.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_grade', message: '请选择有效年级' }, 400);
    const { grade } = parsed.data;
    db.prepare(`
      INSERT INTO user_learning_profiles (user_id, grade) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET grade=excluded.grade
    `).run(userId, grade);
    return c.json<LearningProfile>({ grade });
  });
  return routes;
}
