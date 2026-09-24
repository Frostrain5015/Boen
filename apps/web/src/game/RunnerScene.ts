import Phaser from 'phaser';

export interface GameQuestion {
  id: string;
  stem: string;
  options: { key: string; text: string }[];
  correctKey: string;
}
export interface GameStats {
  score: number;
  totalQuestions: number;
  correctQuestions: number;
  accuracyRate: number;
}
export interface GameEvents {
  onScoreChange?: (s: number) => void;
  onLivesChange?: (l: number) => void;
  onGameOver?: (stats: GameStats) => void;
  onStatsChange?: (stats: Pick<GameStats, 'totalQuestions' | 'correctQuestions' | 'accuracyRate'>) => void;
  onQuestionChange?: (q: GameQuestion | null) => void;
}
export type Subject = 'math' | 'chinese' | 'english' | 'science';

const LANES = 4;
const INIT_LIVES = 3;
const BONUS = 10;
const INITIAL_SPEED = 120;
const MAX_SPEED = 240;
const SPEED_STEP = 8;

const SUBJ: Record<Subject, { accent: number; strong: number; soft: number }> = {
  math:    { accent: 0x14b48a, strong: 0x0e9b76, soft: 0xd9f4ec },
  chinese: { accent: 0xff7a4d, strong: 0xe06530, soft: 0xffe5d7 },
  english: { accent: 0x6c5ce7, strong: 0x5a4bd1, soft: 0xe8e4ff },
  science: { accent: 0x3498db, strong: 0x2c7bc7, soft: 0xd4e6f1 },
};

export class RunnerScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Container;
  private lane = 1;
  private lanesX: number[] = [];
  private barriers: Phaser.GameObjects.Container[] = [];
  private score = 0;
  private totalQuestions = 0;
  private correctQuestions = 0;
  private lives = INIT_LIVES;
  private speed = INITIAL_SPEED;
  private over = false;
  private gameEvents: GameEvents = {};
  private subject: Subject = 'math';
  private subj!: { accent: number; strong: number; soft: number };
  private qQueue: GameQuestion[] = [];
  private currentQ: GameQuestion | null = null;
  private fetching = false;
  private fetchId = 0;   // 用于丢弃切换学科前的旧请求
  private panel!: Phaser.GameObjects.Container;
  private panelTxt!: Phaser.GameObjects.Text;
  private timer = 0;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private keyLeft!: Phaser.Input.Keyboard.Key;
  private keyRight!: Phaser.Input.Keyboard.Key;
  private ground!: Phaser.GameObjects.TileSprite;
  private activeBarrierBatch = false;
  private fetchRetryCount = 0;
  private maxFetchRetries = 3;
  private fetchRetryTimerId: ReturnType<typeof setTimeout> | null = null;
  private touchAreaLeft!: Phaser.GameObjects.Zone;
  private touchAreaRight!: Phaser.GameObjects.Zone;
  private questionHighlightTimer = 0;

  constructor() { super({ key: 'RunnerScene' }); }

  setGameEvents(e: GameEvents) { this.gameEvents = e; }
  setSubject(s: Subject) {
    this.subject = s;
    this.subj = SUBJ[this.subject] || SUBJ.math;
    // 清空旧学科缓存的题目队列，避免切换后短暂出旧题
    this.qQueue = [];
    this.fetching = false;
    this.fetchRetryCount = 0;
    // 切换学科后立即获取新题目
    this.fetchQueue();
  }

  create() {
    this.subj = SUBJ[this.subject] || SUBJ.math;
    const W = this.scale.width;
    const H = this.scale.height;

    this.cameras.main.setBackgroundColor('#fbf6ee');

    // Background
    const g = this.add.graphics();
    g.fillStyle(0xfbf6ee, 1);
    g.fillRect(0, 0, W, H);
    g.lineStyle(1, 0xe0d5c4, 0.5);
    for (let i = 1; i < LANES; i++) g.lineBetween((W / LANES) * i, 0, (W / LANES) * i, H);
    g.generateTexture('bg', W, H);
    g.destroy();
    this.ground = this.add.tileSprite(W / 2, H / 2, W, H, 'bg');

    // Lanes
    for (let i = 0; i < LANES; i++) this.lanesX.push((W / LANES) * i + W / LANES / 2);

    // Player
    this.player = this.add.container(this.lanesX[this.lane], H - 90);
    const body = this.add.circle(0, 0, 18, this.subj.accent);
    body.setStrokeStyle(2, 0xffffff);
    this.player.add(body);
    const hl = this.add.circle(-4, -6, 6, 0xffffff, 0.3);
    this.player.add(hl);
    const glow = this.add.circle(0, 0, 26, this.subj.accent, 0.1);
    this.player.add(glow);
    this.tweens.add({ targets: glow, scale: 1.4, alpha: 0.03, duration: 900, yoyo: true, repeat: -1 });

    // Question panel
    this.panel = this.add.container(W / 2, 42).setDepth(10).setAlpha(0);
    const pb = this.add.rectangle(0, 0, W - 20, 44, 0xfffdf9, 0.92);
    pb.setStrokeStyle(1.5, this.subj.accent);
    this.panel.add(pb);
    this.panelTxt = this.add.text(0, 0, '', {
      fontSize: '12px', fontFamily: 'Nunito, sans-serif', color: '#2c2722',
      wordWrap: { width: W - 44 }, align: 'center',
    }).setOrigin(0.5);
    this.panel.add(this.panelTxt);

    // Keyboard
    const kb = this.input.keyboard!;
    this.keyA = kb.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = kb.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keyLeft = kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    this.keyRight = kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);

    // 触摸/点击支持（移动端可用）：左半屏=左移，右半屏=右移
    this.touchAreaLeft = this.add.zone(0, 0, W / 2, H).setOrigin(0, 0).setDepth(0).setInteractive({ useHandCursor: false });
    this.touchAreaRight = this.add.zone(W / 2, 0, W / 2, H).setOrigin(0, 0).setDepth(0).setInteractive({ useHandCursor: false });
    this.touchAreaLeft.on('pointerdown', () => this.moveTo(Math.max(0, this.lane - 1)));
    this.touchAreaRight.on('pointerdown', () => this.moveTo(Math.min(LANES - 1, this.lane + 1)));

    this.fetchQueue();
  }

  update(_t: number, delta: number) {
    if (this.over) return;
    const dt = delta / 1000;

    this.ground.tilePositionY -= this.speed * dt * 0.12;

    if (Phaser.Input.Keyboard.JustDown(this.keyA) || Phaser.Input.Keyboard.JustDown(this.keyLeft)) {
      this.moveTo(Math.max(0, this.lane - 1));
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyD) || Phaser.Input.Keyboard.JustDown(this.keyRight)) {
      this.moveTo(Math.min(LANES - 1, this.lane + 1));
    }

    // 题目高亮淡出计时器
    if (this.questionHighlightTimer > 0) {
      this.questionHighlightTimer -= delta;
      if (this.questionHighlightTimer <= 0) {
        this.questionHighlightTimer = 0;
        if (!this.currentQ) this.panel.setAlpha(0);
      }
    }

    this.timer += delta;
    if (this.timer >= 800 && this.qQueue.length > 0 && !this.activeBarrierBatch) {
      this.timer = 0;
      this.spawn();
    }

    // 碰撞检测 & 移动：使用更宽的碰撞区，并防止同一帧多次检测
    for (let i = this.barriers.length - 1; i >= 0; i--) {
      const b = this.barriers[i];
      // 已死亡的屏障（已碰撞）仍继续移动，但跳过碰撞检测
      if (!b.getData('dead')) {
        b.y += this.speed * dt;
        if (!b.getData('hit') && b.y >= this.player.y - 40 && b.y <= this.player.y + 40) {
          if (b.getData('lane') === this.lane) {
            this.onCollide(b.getData('ok'));
            b.setData('hit', true);
          }
        }
      } else {
        // 死亡后仅向下移动（动画已在 onCollide 中处理）
        b.y += this.speed * dt;
      }
      // 移出屏幕后销毁并从数组移除；若本批次门全部消失则解锁下一题
      if (b.y > this.scale.height + 100) {
        b.destroy();
        this.barriers.splice(i, 1);
        if (this.barriers.length === 0) {
          this.activeBarrierBatch = false;
        }
      }
    }
  }

  private moveTo(n: number) {
    this.lane = n;
    this.tweens.add({ targets: this.player, x: this.lanesX[n], duration: 70, ease: 'Power2' });
  }

  private spawn() {
    const q = this.qQueue.shift();
    if (!q) return;
    this.currentQ = q;
    this.activeBarrierBatch = true;
    this.gameEvents.onQuestionChange?.(q);
    this.panel.setAlpha(1);
    this.panelTxt.setText(q.stem);

    const W = this.scale.width;
    const lw = W / LANES;

    // 基于服务端返回的 correctKey 确定正确车道（修复：不再随机判定）
    const correctLaneIndex = q.options.findIndex(o => o.key === q.correctKey);
    const ok = correctLaneIndex >= 0 ? correctLaneIndex : 0;

    for (let lane = 0; lane < LANES; lane++) {
      const opt = q.options[lane];
      if (!opt) continue;
      this.barriers.push(this.makeB(this.lanesX[lane], -80, opt.text, opt.key, lane === ok, lane, lw));
    }
  }

  private makeB(x: number, y: number, label: string, optKey: string, ok: boolean, lane: number, lw: number): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);
    const dw = lw - 14;
    const bg = this.add.rectangle(0, 0, dw, 46, 0xfffdf9, 0.92);
    bg.setStrokeStyle(1.5, 0xe0d5c4);
    c.add(bg);

    const circle = this.add.circle(-dw / 2 + 14, 0, 9, this.subj.soft, 1);
    circle.setStrokeStyle(1, this.subj.accent);
    c.add(circle);
    const letter = this.add.text(-dw / 2 + 14, 0, optKey, {
      fontSize: '9px', fontFamily: 'Fredoka, sans-serif',
      color: `#${this.subj.strong.toString(16).padStart(6, '0')}`,
    }).setOrigin(0.5);
    c.add(letter);

    const txt = this.add.text(8, 0, label, {
      fontSize: '11px', fontFamily: 'Nunito, sans-serif', color: '#2c2722',
      wordWrap: { width: dw - 36 }, align: 'left',
    }).setOrigin(0, 0.5);
    c.add(txt);

    c.setAlpha(0);
    this.tweens.add({ targets: c, alpha: 1, duration: 200 });

    c.setData('ok', ok);
    c.setData('lane', lane);
    c.setData('hit', false);
    c.setData('dead', false);
    c.setData('bg', bg);
    return c;
  }

  private onCollide(ok: boolean) {
    const batchOk = ok;

    // 标记所有障碍物已死亡（防止动画期间重复碰撞），保留数组让门继续下移直至出屏
    this.barriers.forEach(b => {
      b.setData('hit', true);
      b.setData('dead', true);
    });

    // 计分 + 统计
    this.totalQuestions++;
    if (batchOk) {
      this.score += BONUS;
      this.correctQuestions++;
      this.speed = Math.min(MAX_SPEED, this.speed + SPEED_STEP);
      this.gameEvents.onScoreChange?.(this.score);
    } else {
      this.speed = Math.max(INITIAL_SPEED, this.speed - SPEED_STEP * 2);
      // 只停掉玩家身上的动画（防止上一次残留），虚化闪烁通过红色门
      this.tweens.killTweensOf(this.player);
      this.tweens.add({
        targets: this.player,
        alpha: 0.1,
        duration: 80,
        yoyo: true,
        repeat: 12,
        ease: 'Sine.easeInOut',
        onComplete: () => this.player.setAlpha(1),
      });
      this.cameras.main.flash(300, 242, 85, 101, false);
      this.lives--;
      this.gameEvents.onLivesChange?.(this.lives);
    }
    this.emitStats();

    // 视觉反馈：按正确/错误分别处理每扇门
    this.barriers.forEach(b => {
      const bg = b.getData('bg') as Phaser.GameObjects.Rectangle;
      if (batchOk) {
        // 正确的门 → 变绿，向上漂移渐消失（300ms），玩家可通行
        bg.setFillStyle(0x18a558, 0.85);
        bg.setStrokeStyle(2, 0x34d399);
        this.tweens.add({
          targets: b,
          alpha: 0,
          y: b.y - 30,
          scaleY: 0.5,
          duration: 300,
          ease: 'Power2',
          onComplete: () => { try { b.destroy(); } catch { /* ignore */ } },
        });
      } else {
        // 错误的门 → 变红，虚化闪烁 1.5s 后消失，玩家通过后扣 1 点生命值（已在上面处理）
        bg.setFillStyle(0xf2557a, 0.85);
        bg.setStrokeStyle(2, 0xfb7185);
        this.tweens.add({
          targets: b,
          alpha: 0.15,
          duration: 120,
          yoyo: true,
          repeat: 10,
          ease: 'Sine.easeInOut',
          onComplete: () => {
            this.tweens.add({
              targets: b,
              alpha: 0,
              duration: 200,
              onComplete: () => { try { b.destroy(); } catch { /* ignore */ } },
            });
          },
        });
      }
      // 所有门继续匀速下移（已在 update 中处理）
    });

    // 切换下一题：门在 update 中全部出屏后自动解锁（由 onCollide 标记 dead，update 中检查 barriers.length === 0 重置）

    // 保持题目面板显示 1.5 秒后再隐藏
    this.questionHighlightTimer = 1500;
    this.currentQ = null;
    this.gameEvents.onQuestionChange?.(null);

    // 生命值耗尽 → 结束
    if (this.lives <= 0) {
      this.doGameOver();
      return;
    }

    // 立即补充题目并准备下一题
    if (this.qQueue.length < 3) this.fetchQueue();
  }

  private doGameOver() {
    this.over = true;
    // 清理未完成的 fetch 重试定时器，防止对已结束的 scene 操作
    if (this.fetchRetryTimerId) { clearTimeout(this.fetchRetryTimerId); this.fetchRetryTimerId = null; }
    this.barriers.forEach(b => b.destroy());
    this.barriers = [];
    this.player.setAlpha(0);
    this.gameEvents.onGameOver?.(this.getStats());
  }

  private getStats(): GameStats {
    return {
      score: this.score,
      totalQuestions: this.totalQuestions,
      correctQuestions: this.correctQuestions,
      accuracyRate: this.totalQuestions === 0 ? 0 : Math.round((this.correctQuestions / this.totalQuestions) * 100),
    };
  }

  private emitStats() {
    this.gameEvents.onStatsChange?.({
      totalQuestions: this.totalQuestions,
      correctQuestions: this.correctQuestions,
      accuracyRate: this.totalQuestions === 0 ? 0 : Math.round((this.correctQuestions / this.totalQuestions) * 100),
    });
  }

  doRestart() {
    this.over = false;
    this.score = 0; this.totalQuestions = 0; this.correctQuestions = 0; this.lives = INIT_LIVES; this.speed = INITIAL_SPEED;
    this.lane = 1; this.timer = 0; this.questionHighlightTimer = 0; this.fetchRetryCount = 0;
    this.currentQ = null; this.qQueue = []; this.fetching = false; this.activeBarrierBatch = false;
    // 触发 fetch（setSubject 已触发时会因 fetching=true 直接返回；restart 单独调用时则触发新 fetch）
    this.fetchQueue();
    // 清理未完成的 fetch 重试定时器
    if (this.fetchRetryTimerId) { clearTimeout(this.fetchRetryTimerId); this.fetchRetryTimerId = null; }
    this.barriers.forEach(b => { try { b.destroy(); } catch { console.warn('[game] barrier destroy failed during restart'); } });
    this.barriers = [];
    this.player.setAlpha(1); this.player.x = this.lanesX[this.lane]; this.player.y = this.scale.height - 90;
    this.panel.setAlpha(0);
    this.cameras.main.resetFX();
    // 同步 Vue 覆盖层状态
    this.gameEvents.onScoreChange?.(0);
    this.gameEvents.onLivesChange?.(INIT_LIVES);
    this.emitStats();
  }

  private async fetchQueue() {
    if (this.fetching || this.qQueue.length >= 5) return;
    this.fetching = true;
    const fetchId = ++this.fetchId; // 捕获当前请求 ID，切换学科时递增以丢弃过期响应
    try {
      const need = 5 - this.qQueue.length;
      const url = `/api/game/questions?subject=${this.subject}&count=${need}`;
      const res = await fetch(url);
      // 切换学科后已发出新请求，丢弃旧响应
      if (fetchId !== this.fetchId) { this.fetching = false; return; }
      if (!res.ok) {
        console.warn('[game] 批量获取题目失败:', res.status);
        this.fetching = false;
        return;
      }
      const data = await res.json();
      const questions = data?.questions ?? [];
      if (questions.length > 0) {
        // 再次检查（防止极端竞态）
        if (fetchId !== this.fetchId) { this.fetching = false; return; }
        for (const q of questions) {
          if (q) this.qQueue.push(q);
        }
        this.fetchRetryCount = 0;
      } else if (this.fetchRetryCount < this.maxFetchRetries) {
        this.fetching = false;
        this.fetchRetryCount++;
        const delay = Math.min(1000 * Math.pow(2, this.fetchRetryCount - 1), 6000);
        console.warn(`[game] 题目获取失败，${delay}ms 后重试 (${this.fetchRetryCount}/${this.maxFetchRetries})`);
        this.fetchRetryTimerId = setTimeout(() => {
          this.fetchRetryTimerId = null;
          this.fetchQueue();
        }, delay);
      }
    } catch (e) {
      console.warn('[game] fetch err:', e);
    }
    this.fetching = false;
  }
}
