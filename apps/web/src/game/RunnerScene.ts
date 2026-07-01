import Phaser from 'phaser';

/** 题目数据接口 */
export interface GameQuestion {
  id: string;
  stem: string;
  options: { key: string; text: string }[];
  correctKey: string;
}

/** 场景事件 */
export interface GameEvents {
  onScoreChange?: (score: number) => void;
  onLivesChange?: (lives: number) => void;
  onGameOver?: (finalScore: number) => void;
  onQuestionChange?: (question: GameQuestion | null) => void;
}

const LANE_COUNT = 4;
const PLAYER_SPEED = 60;
const MAX_SPEED = 230;
const SPEED_INCREMENT = 5;
const INITIAL_LIVES = 3;
const BONUS_PER_QUESTION = 10;
const GAME_WIDTH = 480;
const GAME_HEIGHT = 720;

/** 拦截门颜色（按正确/错误区分视觉效果） */
const BARRIER_COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf39c12];

export class RunnerScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Rectangle;
  private currentLane = 1;
  private lanes: number[] = [];
  private ground!: Phaser.GameObjects.TileSprite;
  private barriers: Phaser.GameObjects.Container[] = [];
  private scoreText!: Phaser.GameObjects.Text;
  private lives = INITIAL_LIVES;
  private score = 0;
  private gameSpeed = 100;
  private questionActive = false;
  private currentQuestion: GameQuestion | null = null;
  private events: GameEvents = {};
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private questionPanel!: Phaser.GameObjects.Container;
  private lifeIcons: Phaser.GameObjects.Text[] = [];
  private gameOverGroup!: Phaser.GameObjects.Container;
  private isGameOver = false;
  private questionQueue: GameQuestion[] = [];
  private isFetching = false;
  private backgroundCircles: Phaser.GameObjects.Arc[] = [];
  private obstacleTimer = 0;
  private obstacleInterval = 3000;

  constructor() {
    super({ key: 'RunnerScene' });
  }

  /** 设置事件回调 */
  setEvents(events: GameEvents): void {
    this.events = events;
  }

  /** 推送一道新题 */
  pushQuestion(q: GameQuestion): void {
    this.questionQueue.push(q);
  }

  create(): void {
    const { width, height } = this.scale;

    // ── 装饰背景（渐变感：滚动圆点） ──────
    this.cameras.main.setBackgroundColor('#0f172a');

    // 地板条纹装饰（TileSprite）
    this.ground = this.add.tileSprite(width / 2, height, width, height * 0.6, '__GROUND__');
    // 创建虚拟地面纹理
    const gfx = this.add.graphics();
    gfx.fillStyle(0x1e293b, 1);
    gfx.fillRect(0, 0, width, height * 0.6);
    // 跑道分割线
    const laneWidth = width / LANE_COUNT;
    gfx.lineStyle(2, 0x334155, 0.4);
    for (let i = 1; i < LANE_COUNT; i++) {
      gfx.lineBetween(i * laneWidth, 0, i * laneWidth, height * 0.6);
    }
    // 中间虚线
    gfx.lineStyle(1, 0x475569, 0.3);
    for (let y = 0; y < height * 0.6; y += 40) {
      gfx.lineBetween(0, y, width, y);
    }
    gfx.generateTexture('ground_tile', width, height * 0.6);
    gfx.destroy();
    this.ground.setTexture('ground_tile');
    this.ground.setOrigin(0.5, 1);
    this.ground.setPosition(width / 2, height);
    this.ground.setDisplaySize(width, height);

    // ── 计算 4 条跑道中心 x ──────
    const laneWidth = width / LANE_COUNT;
    for (let i = 0; i < LANE_COUNT; i++) {
      this.lanes.push(laneWidth * i + laneWidth / 2);
    }

    // ── 玩家（发光小球） ──────
    this.player = this.add.rectangle(this.lanes[this.currentLane], height - 100, 36, 36, 0x6366f1, 1);
    this.player.setStrokeStyle(3, 0x818cf8);
    // 发光效果（多个同心圆叠加）
    const glow = this.add.circle(this.player.x, this.player.y, 24, 0x6366f1, 0.2);
    this.tweens.add({
      targets: glow,
      alpha: 0.05,
      scale: 1.5,
      duration: 800,
      yoyo: true,
      repeat: -1,
    });

    // ── 顶部 HUD ──────
    this.scoreText = this.add.text(16, 16, '🏆 0', {
      fontSize: '22px',
      fontFamily: 'Fredoka, sans-serif',
      color: '#f1f5f9',
    });

    // 生命值图标
    this.updateLifeIcons();

    // ── 题目面板（顶部） ──────
    this.questionPanel = this.add.container(width / 2, 60);
    this.questionPanel.setAlpha(0);
    const panelBg = this.add.rectangle(0, 0, width - 32, 80, 0x1e293b, 0.9);
    panelBg.setStrokeStyle(1, 0x6366f1);
    this.questionPanel.add(panelBg);
    const qText = this.add.text(0, -4, '', {
      fontSize: '15px',
      fontFamily: 'Nunito, sans-serif',
      color: '#e2e8f0',
      wordWrap: { width: width - 56 },
      align: 'center',
    });
    qText.setOrigin(0.5);
    this.questionPanel.add(qText);
    (this.questionPanel as any).__text = qText;

    // ── 键盘 ──────
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keyA = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D);

    // ── 游戏结束界面（预创建但隐藏） ──────
    this.gameOverGroup = this.add.container(width / 2, height / 2);
    this.gameOverGroup.setAlpha(0);
    const goBg = this.add.rectangle(0, 0, width * 0.8, 240, 0x0f172a, 0.95);
    goBg.setStrokeStyle(2, 0x6366f1);
    this.gameOverGroup.add(goBg);
    const goTitle = this.add.text(0, -80, '游戏结束', {
      fontSize: '36px',
      fontFamily: 'Fredoka, sans-serif',
      color: '#f1f5f9',
    });
    goTitle.setOrigin(0.5);
    this.gameOverGroup.add(goTitle);
    const goScore = this.add.text(0, -20, '', {
      fontSize: '24px',
      fontFamily: 'Nunito, sans-serif',
      color: '#818cf8',
    });
    goScore.setOrigin(0.5);
    (this.gameOverGroup as any).__scoreText = goScore;
    this.gameOverGroup.add(goScore);
    const restartBtn = this.add.text(0, 50, '🔄 再来一次', {
      fontSize: '20px',
      fontFamily: 'Fredoka, sans-serif',
      color: '#22d3ee',
    });
    restartBtn.setOrigin(0.5);
    restartBtn.setInteractive({ useHandCursor: true });
    restartBtn.on('pointerdown', () => this.restartGame());
    this.gameOverGroup.add(restartBtn);
    this.gameOverGroup.setDepth(100);
    this.gameOverGroup.setScrollFactor(0);

    // ── 获取第一道题 ──────
    this.fetchNextQuestion();
  }

  update(_time: number, delta: number): void {
    if (this.isGameOver) return;

    const dt = delta / 1000;

    // ── 地面滚动 ──────
    this.ground.tilePositionY -= this.gameSpeed * dt * 0.3;

    // ── 玩家移动 (A/D 或 ←/→) ──────
    if (Phaser.Input.Keyboard.JustDown(this.keyA) || Phaser.Input.Keyboard.JustDown(this.cursors.left)) {
      this.currentLane = Math.max(0, this.currentLane - 1);
      this.tweens.add({
        targets: this.player,
        x: this.lanes[this.currentLane],
        duration: 120,
        ease: 'Power2',
      });
    } else if (Phaser.Input.Keyboard.JustDown(this.keyD) || Phaser.Input.Keyboard.JustDown(this.cursors.right)) {
      this.currentLane = Math.min(LANE_COUNT - 1, this.currentLane + 1);
      this.tweens.add({
        targets: this.player,
        x: this.lanes[this.currentLane],
        duration: 120,
        ease: 'Power2',
      });
    }

    // ── 拦截门移动 + 碰撞检测 ──────
    this.obstacleTimer += delta;
    if (this.obstacleTimer >= this.obstacleInterval) {
      this.obstacleTimer = 0;
      if (this.questionQueue.length > 0 || !this.isFetching) {
        this.spawnBarriers();
      }
    }

    for (let i = this.barriers.length - 1; i >= 0; i--) {
      const container = this.barriers[i];
      container.y += this.gameSpeed * dt;

      // 碰撞检测
      if (!(container as any).__passed && container.y >= this.player.y - 50 && container.y <= this.player.y + 50) {
        const barrierLane = (container as any).__lane;
        if (barrierLane === this.currentLane) {
          // 玩家撞上了当前跑道的门
          const isCorrect = (container as any).__correct;
          this.handleBarrierCollision(container, isCorrect);
        }
      }

      // 超出屏幕移除
      if (container.y > this.scale.height + 100) {
        container.destroy();
        this.barriers.splice(i, 1);
      }
    }
  }

  /** 生成一组拦截门（4个跑道各一个） */
  private spawnBarriers(): void {
    if (!this.currentQuestion && this.questionQueue.length === 0) return;

    const question = this.questionQueue.shift() || this.currentQuestion;
    if (!question) return;
    this.currentQuestion = question;
    this.questionActive = true;

    // 通知 Vue 更新题目显示
    this.events.onQuestionChange?.(question);

    // 更新顶部题目面板
    this.updateQuestionPanel(question);

    const { width, height } = this.scale;
    const laneWidth = width / LANE_COUNT;

    // 随机分配正确选项到某条跑道
    const correctLane = Phaser.Math.Between(0, LANE_COUNT - 1);

    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const option = question.options[lane];
      if (!option) continue;

      const isCorrect = lane === correctLane;
      const barrier = this.createBarrier(
        this.lanes[lane],
        -120,
        option.text,
        isCorrect,
        lane,
      );
      this.barriers.push(barrier);
    }
  }

  /** 创建一个拦截门 */
  private createBarrier(x: number, y: number, label: string, isCorrect: boolean, lane: number): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);

    // 门框
    const doorWidth = this.scale.width / LANE_COUNT - 20;
    const doorHeight = 60;

    const bg = this.add.rectangle(0, 0, doorWidth, doorHeight, isCorrect ? 0x065f46 : 0x7f1d1d, 0.85);
    bg.setStrokeStyle(2, isCorrect ? 0x10b981 : 0xef4444);
    container.add(bg);

    // 选项文字
    const text = this.add.text(0, 0, label, {
      fontSize: '15px',
      fontFamily: 'Nunito, sans-serif',
      color: '#f1f5f9',
      wordWrap: { width: doorWidth - 16 },
      align: 'center',
    });
    text.setOrigin(0.5);
    container.add(text);

    // 标记
    (container as any).__correct = isCorrect;
    (container as any).__lane = lane;
    (container as any).__passed = false;

    // 入口动画
    container.setAlpha(0);
    this.tweens.add({
      targets: container,
      alpha: 1,
      duration: 200,
      ease: 'Power2',
    });

    return container;
  }

  /** 碰撞处理 */
  private handleBarrierCollision(container: Phaser.GameObjects.Container, isCorrect: boolean): void {
    (container as any).__passed = true;

    if (isCorrect) {
      // ✅ 正确：加分 + 加速
      this.score += BONUS_PER_QUESTION;
      this.gameSpeed = Math.min(MAX_SPEED, this.gameSpeed + SPEED_INCREMENT);
      this.obstacleInterval = Math.max(1200, this.obstacleInterval - 50);
      this.events.onScoreChange?.(this.score);
      this.scoreText.setText(`🏆 ${this.score}`);

      // 正确闪光
      this.cameras.main.flash(200, 99, 102, 241, false, (_cam: any, progress: number) => {
        if (progress === 1) this.cameras.main.resetFX();
      });

      // 销毁该组拦截门
      for (const b of this.barriers) {
        this.tweens.add({
          targets: b,
          alpha: 0,
          scale: 0.5,
          duration: 200,
          onComplete: () => b.destroy(),
        });
      }
      this.barriers = [];
      this.questionActive = false;
      this.currentQuestion = null;
      this.questionPanel.setAlpha(0);
      this.events.onQuestionChange?.(null);

      // 取下一题
      if (this.questionQueue.length === 0) {
        this.fetchNextQuestion();
      }
    } else {
      // ❌ 错误：扣一条命
      this.lives--;
      this.updateLifeIcons();
      this.events.onLivesChange?.(this.lives);

      // 错误红闪
      this.cameras.main.flash(300, 239, 68, 68, false, (_cam: any, progress: number) => {
        if (progress === 1) this.cameras.main.resetFX();
      });

      if (this.lives <= 0) {
        this.gameOver();
      } else {
        // 减速惩罚
        this.gameSpeed = Math.max(PLAYER_SPEED, this.gameSpeed - 30);
      }
    }
  }

  /** 更新生命图标 */
  private updateLifeIcons(): void {
    // 清除旧图标
    for (const icon of this.lifeIcons) icon.destroy();
    this.lifeIcons = [];

    for (let i = 0; i < this.lives; i++) {
      const heart = this.add.text(this.scale.width - 32 - i * 32, 16, '❤️', {
        fontSize: '20px',
      });
      this.lifeIcons.push(heart);
    }
  }

  /** 更新题目面板 */
  private updateQuestionPanel(question: GameQuestion): void {
    const text = (this.questionPanel as any).__text as Phaser.GameObjects.Text;
    text.setText(question.stem);
    this.questionPanel.setAlpha(1);
  }

  /** 从后端获取题目 */
  private async fetchNextQuestion(): Promise<void> {
    if (this.isFetching) return;
    this.isFetching = true;

    // 预缓存 5 道题
    const needed = 5 - this.questionQueue.length;
    if (needed <= 0) {
      this.isFetching = false;
      return;
    }

    try {
      const res = await fetch('/api/game/question');
      if (!res.ok) throw new Error('Failed to fetch question');
      const data = await res.json();

      if (data.question) {
        this.pushQuestion(data.question);
      }

      // 如果还不够，继续获取
      if (this.questionQueue.length < 5) {
        this.fetchNextQuestion();
      } else {
        this.isFetching = false;
      }
    } catch (err) {
      console.warn('[game] 获取题目失败:', err);
      this.isFetching = false;
    }
  }

  /** 游戏结束 */
  private gameOver(): void {
    this.isGameOver = true;
    this.barriers.forEach(b => b.destroy());
    this.barriers = [];
    this.player.setAlpha(0);

    // 显示结算界面
    const scoreText = (this.gameOverGroup as any).__scoreText as Phaser.GameObjects.Text;
    scoreText.setText(`最终得分：${this.score}`);
    this.tweens.add({
      targets: this.gameOverGroup,
      alpha: 1,
      duration: 400,
    });

    this.events.onGameOver?.(this.score);
  }

  /** 重新开始 */
  private restartGame(): void {
    this.isGameOver = false;
    this.score = 0;
    this.lives = INITIAL_LIVES;
    this.gameSpeed = 100;
    this.currentLane = 1;
    this.obstacleTimer = 0;
    this.obstacleInterval = 3000;
    this.questionActive = false;
    this.currentQuestion = null;
    this.questionQueue = [];
    this.isFetching = false;

    this.barriers.forEach(b => b.destroy());
    this.barriers = [];

    this.player.setAlpha(1);
    this.player.x = this.lanes[this.currentLane];
    this.player.y = this.scale.height - 100;

    this.scoreText.setText('🏆 0');
    this.updateLifeIcons();
    this.questionPanel.setAlpha(0);
    this.gameOverGroup.setAlpha(0);
    this.events.onQuestionChange?.(null);

    this.cameras.main.resetFX();

    this.fetchNextQuestion();
  }
}
