import Phaser from 'phaser';

/* ── 类型 ── */
export interface GameQuestion {
  id: string;
  stem: string;
  options: { key: string; text: string }[];
  correctKey: string;
}

export interface GameEvents {
  onScoreChange?: (s: number) => void;
  onLivesChange?: (l: number) => void;
  onGameOver?: (s: number) => void;
  onQuestionChange?: (q: GameQuestion | null) => void;
}

export type Subject = 'math' | 'chinese' | 'english' | 'science';

/* ── 常量 ── */
const LANES = 4;
const INIT_LIVES = 3;
const BONUS = 10;
const W = 480, H = 720;
const P_SPEED = 100, MAX_SPEED = 220, SPEED_STEP = 8;
const OBS_INTERVAL = 3000;

/** 学科色彩映射（匹配项目 CSS 变量） */
const SUBJECT_COLORS: Record<Subject, { accent: number; accentSoft: number; glow: number; label: string }> = {
  math:    { accent: 0x14b48a, accentSoft: 0xd9f4ec, glow: 0x14b48a, label: '数学' },
  chinese: { accent: 0xff7a4d, accentSoft: 0xffe5d7, glow: 0xff7a4d, label: '语文' },
  english: { accent: 0x6c5ce7, accentSoft: 0xe8e4ff, glow: 0x6c5ce7, label: '英语' },
  science: { accent: 0x3498db, accentSoft: 0xd4e6f1, glow: 0x3498db, label: '科学' },
};

export class RunnerScene extends Phaser.Scene {
  /* 游戏状态 */
  private player!: Phaser.GameObjects.Container;
  private currentLane = 1;
  private lanes: number[] = [];
  private ground!: Phaser.GameObjects.TileSprite;
  private barriers: Phaser.GameObjects.Container[] = [];
  private score = 0;
  private lives = INIT_LIVES;
  private speed = P_SPEED;
  private isOver = false;
  private events: GameEvents = {};
  private subject: Subject = 'math';
  private subjectColor!: typeof SUBJECT_COLORS.math;

  /* 题目系统 */
  private questionQueue: GameQuestion[] = [];
  private currentQuestion: GameQuestion | null = null;
  private isFetching = false;
  private questionPanel!: Phaser.GameObjects.Container;
  private questionActive = false;

  /* HUD */
  private scoreText!: Phaser.GameObjects.Text;
  private lifeHearts: Phaser.GameObjects.Text[] = [];
  private gameOverGroup!: Phaser.GameObjects.Container;

  /* 计时器 */
  private obsTimer = 0;

  constructor() { super({ key: 'RunnerScene' }); }

  setEvents(e: GameEvents): void { this.events = e; }
  setSubject(s: Subject): void { this.subject = s; }
  pushQuestion(q: GameQuestion): void { this.questionQueue.push(q); }

  create(): void {
    this.subjectColor = SUBJECT_COLORS[this.subject] || SUBJECT_COLORS.math;
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#1e1b2e');

    /* ── 跑道背景 ── */
    const gfx = this.add.graphics();
    const laneW = width / LANES;
    // 深色底
    gfx.fillStyle(0x2d2a3e, 1);
    gfx.fillRect(0, 0, width, height);
    // 跑道分割线
    gfx.lineStyle(1, 0x3d3a52, 0.5);
    for (let i = 1; i < LANES; i++) gfx.lineBetween(i * laneW, 0, i * laneW, height);
    // 中间虚线
    gfx.lineStyle(1, 0x4a4760, 0.25);
    for (let y = 0; y < height; y += 40) gfx.lineBetween(0, y, width, y);
    gfx.generateTexture('bg_tile', width, height);
    gfx.destroy();
    this.ground = this.add.tileSprite(width / 2, height / 2, width, height, 'bg_tile');

    /* ── 4 跑道中心 ── */
    for (let i = 0; i < LANES; i++) this.lanes.push(laneW * i + laneW / 2);

    /* ── 玩家（黏土小球） ── */
    const c = this.subjectColor.accent;
    this.player = this.add.container(this.lanes[this.currentLane], height - 100);
    const body = this.add.circle(0, 0, 20, c);
    body.setStrokeStyle(3, 0xffffff);
    this.player.add(body);
    // 发光光晕
    const glow = this.add.circle(0, 0, 30, c, 0.15);
    this.player.add(glow);
    this.tweens.add({ targets: glow, scale: 1.6, alpha: 0.05, duration: 900, yoyo: true, repeat: -1 });

    /* ── HUD ── */
    this.scoreText = this.add.text(14, 14, '0', { fontSize: '26px', fontFamily: 'Fredoka, sans-serif', color: '#e2e8f0' }).setDepth(10);
    this.updateHearts();
    this.createQuestionPanel();
    this.createGameOverScreen();

    /* ── 键盘 ── */
    const kb = this.input.keyboard!;
    kb.createCursorKeys();
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);

    /* ── 获取首题 ── */
    this.fetchNextQuestions();
  }

  update(_t: number, delta: number): void {
    if (this.isOver) return;
    const dt = delta / 1000;

    // 地面滚动
    this.ground.tilePositionY -= this.speed * dt * 0.2;

    // 左右移动（A/D 或 ←/→）
    const kb = this.input.keyboard!;
    if (Phaser.Input.Keyboard.JustDown(kb.addKey(Phaser.Input.Keyboard.KeyCodes.A)) as any ||
        Phaser.Input.Keyboard.JustDown(kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT)) as any) {
      this.moveTo(Math.max(0, this.currentLane - 1));
    } else if (Phaser.Input.Keyboard.JustDown(kb.addKey(Phaser.Input.Keyboard.KeyCodes.D)) as any ||
               Phaser.Input.Keyboard.JustDown(kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT)) as any) {
      this.moveTo(Math.min(LANES - 1, this.currentLane + 1));
    }

    // 生成拦截门
    this.obsTimer += delta;
    if (this.obsTimer >= OBS_INTERVAL && (this.questionQueue.length > 0 || !this.isFetching)) {
      this.obsTimer = 0;
      this.spawnBarriers();
    }

    // 拦截门移动 + 碰撞
    for (let i = this.barriers.length - 1; i >= 0; i--) {
      const b = this.barriers[i];
      b.y += this.speed * dt;

      if (!(b as any).__triggered && b.y >= this.player.y - 45 && b.y <= this.player.y + 45) {
        const lane = (b as any).__lane;
        if (lane === this.currentLane) {
          this.onHit((b as any).__correct);
          (b as any).__triggered = true;
        }
      }

      if (b.y > height + 120) { b.destroy(); this.barriers.splice(i, 1); }
    }
  }

  /* ── 移动跑道 ── */
  private moveTo(lane: number): void {
    this.currentLane = lane;
    this.tweens.add({ targets: this.player, x: this.lanes[lane], duration: 100, ease: 'Power2' });
  }

  /* ── 拦截门 ── */
  private spawnBarriers(): void {
    const q = this.questionQueue.shift() || this.currentQuestion;
    if (!q) return;
    this.currentQuestion = q;
    this.questionActive = true;
    this.events.onQuestionChange?.(q);
    this.showQuestionPanel(q);

    const laneW = this.scale.width / LANES;
    const correctLane = Phaser.Math.Between(0, LANES - 1);

    for (let lane = 0; lane < LANES; lane++) {
      const option = q.options[lane];
      if (!option) continue;
      const isCorrect = lane === correctLane;
      this.barriers.push(this.createBarrier(this.lanes[lane], -100, option.text, isCorrect, lane));
    }
  }

  private createBarrier(x: number, y: number, label: string, correct: boolean, lane: number): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);
    const doorW = this.scale.width / LANES - 18;
    const doorH = 58;

    // 所有门初始外观一致：深色半透明底 + 白色圆角框
    const bg = this.add.rectangle(0, 0, doorW, doorH, 0x1e293b, 0.85);
    bg.setStrokeStyle(2, 0x475569);
    bg.setCornerRadius(12);
    c.add(bg);

    // 选项图标
    const iconSize = 22;
    const icon = this.add.circle(-doorW / 2 + 18, 0, iconSize / 2, 0x334155, 1);
    icon.setStrokeStyle(1, 0x64748b);
    c.add(icon);
    const iconLabel = this.add.text(-doorW / 2 + 18, 0, String.fromCharCode(65 + lane), { fontSize: '10px', fontFamily: 'Fredoka, sans-serif', color: '#94a3b8' }).setOrigin(0.5);
    c.add(iconLabel);

    // 答案文字
    const txt = this.add.text(6, 0, label, { fontSize: '12px', fontFamily: 'Nunito, sans-serif', color: '#e2e8f0', wordWrap: { width: doorW - 44 }, align: 'left' }).setOrigin(0, 0.5);
    c.add(txt);

    // 入场淡入
    c.setAlpha(0);
    this.tweens.add({ targets: c, alpha: 1, duration: 250 });

    // 标记
    (c as any).__correct = correct;
    (c as any).__lane = lane;
    (c as any).__triggered = false;
    (c as any).__bg = bg;
    (c as any).__icon = icon;
    (c as any).__iconLabel = iconLabel;
    (c as any).__txt = txt;
    return c;
  }

  /* ── 碰撞反馈 ── */
  private onHit(correct: boolean): void {
    const success = this.subjectColor.accent;
    const error = 0xf2557a; // --error from project

    if (correct) {
      // ✅ 正确：目标变绿 → 缩小淡出
      this.score += BONUS;
      this.speed = Math.min(MAX_SPEED, this.speed + SPEED_STEP);
      this.events.onScoreChange?.(this.score);
      this.scoreText.setText(`${this.score}`);

      // 所有屏障变色 + 缩小淡出
      for (const b of this.barriers) {
        const bg = (b as any).__bg as Phaser.GameObjects.Rectangle;
        bg.setFillStyle(success, 0.9);
        bg.setStrokeStyle(2, 0x34d399);
        // 其他门也变成灰色表示已过时
        if (!(b as any).__correct) {
          bg.setFillStyle(0x334155, 0.7);
          bg.setStrokeStyle(1, 0x475569);
        }
        this.tweens.add({ targets: b, alpha: 0, scaleY: 0.3, y: b.y - 60, duration: 350, delay: 60, onComplete: () => b.destroy() });
      }
      this.barriers = [];
      this.questionActive = false;
      this.currentQuestion = null;
      this.questionPanel.setAlpha(0);
      this.events.onQuestionChange?.(null);
      if (this.questionQueue.length < 3) this.fetchNextQuestions();
    } else {
      // ❌ 错误：门变红 + 玩家闪烁
      const bg = (this.barriers.find(b => (b as any).__lane === this.currentLane) as any)?.__bg;
      if (bg) { bg.setFillStyle(error, 0.9); bg.setStrokeStyle(2, 0xfb7185); }

      // 玩家闪烁
      this.tweens.add({
        targets: this.player,
        alpha: 0.15,
        duration: 100,
        yoyo: true,
        repeat: 5,
        onComplete: () => { this.player.setAlpha(1); },
      });
      // 屏幕红闪
      this.cameras.main.flash(400, 242, 85, 101, false);

      this.lives--;
      this.updateHearts();
      this.events.onLivesChange?.(this.lives);
      this.speed = Math.max(P_SPEED, this.speed - SPEED_STEP * 2);

      if (this.lives <= 0) this.gameOver();
    }
  }

  /* ── 题目面板 ── */
  private createQuestionPanel(): void {
    const w = this.scale.width - 32;
    this.questionPanel = this.add.container(this.scale.width / 2, 52).setDepth(10).setAlpha(0);
    const bg = this.add.rectangle(0, 0, w, 62, 0x1e293b, 0.92);
    bg.setStrokeStyle(1, this.subjectColor.accent);
    bg.setCornerRadius(14);
    this.questionPanel.add(bg);
    const txt = this.add.text(0, 0, '', { fontSize: '13px', fontFamily: 'Nunito, sans-serif', color: '#e2e8f0', wordWrap: { width: w - 24 }, align: 'center' }).setOrigin(0.5);
    this.questionPanel.add(txt);
    (this.questionPanel as any).__txt = txt;
  }

  private showQuestionPanel(q: GameQuestion): void {
    const txt = (this.questionPanel as any).__txt as Phaser.GameObjects.Text;
    txt.setText(q.stem);
    this.questionPanel.setAlpha(1);
  }

  /* ── HUD ── */
  private updateHearts(): void {
    this.lifeHearts.forEach(h => h.destroy());
    this.lifeHearts = [];
    for (let i = 0; i < this.lives; i++) {
      const h = this.add.text(this.scale.width - 32 - i * 30, 14, '❤️', { fontSize: '18px' }).setDepth(10);
      this.lifeHearts.push(h);
    }
  }

  /* ── 结算 ── */
  private createGameOverScreen(): void {
    const c = this.subjectColor;
    this.gameOverGroup = this.add.container(this.scale.width / 2, this.scale.height / 2).setDepth(100).setAlpha(0).setScrollFactor(0);
    const bg = this.add.rectangle(0, 0, this.scale.width * 0.8, 240, 0x1e1b2e, 0.95);
    bg.setStrokeStyle(2, c.accent);
    bg.setCornerRadius(20);
    this.gameOverGroup.add(bg);
    const title = this.add.text(0, -80, '游戏结束', { fontSize: '34px', fontFamily: 'Fredoka, sans-serif', color: '#f1f5f9' }).setOrigin(0.5);
    this.gameOverGroup.add(title);
    const sc = this.add.text(0, -20, '', { fontSize: '22px', fontFamily: 'Nunito, sans-serif', color: `#${c.accent.toString(16).padStart(6, '0')}` }).setOrigin(0.5);
    (this.gameOverGroup as any).__sc = sc;
    this.gameOverGroup.add(sc);
    const btn = this.add.text(0, 50, '🔄 再来一次', { fontSize: '20px', fontFamily: 'Fredoka, sans-serif', color: '#22d3ee' }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    btn.on('pointerdown', () => this.restart());
    this.gameOverGroup.add(btn);
  }

  private gameOver(): void {
    this.isOver = true;
    this.barriers.forEach(b => b.destroy());
    this.barriers = [];
    this.player.setAlpha(0);
    const sc = (this.gameOverGroup as any).__sc as Phaser.GameObjects.Text;
    sc.setText(`${this.score} 分`);
    this.tweens.add({ targets: this.gameOverGroup, alpha: 1, duration: 400 });
    this.events.onGameOver?.(this.score);
  }

  /* ── 重新开始 ── */
  restart(): void {
    this.isOver = false;
    this.score = 0; this.lives = INIT_LIVES; this.speed = P_SPEED;
    this.currentLane = 1; this.obsTimer = 0;
    this.questionActive = false; this.currentQuestion = null;
    this.questionQueue = []; this.isFetching = false;
    this.barriers.forEach(b => b.destroy()); this.barriers = [];
    this.player.setAlpha(1); this.player.x = this.lanes[this.currentLane]; this.player.y = 620;
    this.scoreText.setText('0');
    this.updateHearts();
    this.questionPanel.setAlpha(0);
    this.gameOverGroup.setAlpha(0);
    this.cameras.main.resetFX();
    this.fetchNextQuestions();
  }

  /* ── 取题 ── */
  private async fetchNextQuestions(): Promise<void> {
    if (this.isFetching) return;
    this.isFetching = true;
    const needed = 5 - this.questionQueue.length;
    if (needed <= 0) { this.isFetching = false; return; }
    try {
      for (let i = 0; i < needed; i++) {
        const res = await fetch(`/api/game/question?subject=${this.subject}`);
        if (!res.ok) break;
        const data = await res.json();
        if (data.question) this.questionQueue.push(data.question);
        else break;
      }
    } catch (err) { console.warn('[game] 获取题目失败:', err); }
    this.isFetching = false;
  }
}
