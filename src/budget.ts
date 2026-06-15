/**
 * Token 预算追踪 + 阈值告警。
 * 阈值：70% 黄牌（建议存盘）/ 90% 红牌（强制提示重启）。
 */
import { EventEmitter } from 'node:events';

export type BudgetLevel = 'green' | 'yellow' | 'red';

export interface BudgetEvents {
  /** 任何一次 add 都触发 */
  change: (used: number, max: number, level: BudgetLevel) => void;
  /** 第一次跨过 70% 阈值 */
  yellow: (used: number, max: number) => void;
  /** 第一次跨过 90% 阈值 */
  red: (used: number, max: number) => void;
}

export class Budget extends EventEmitter {
  private _used = 0;
  private _yellowTripped = false;
  private _redTripped = false;

  constructor(public readonly max: number = 80_000) {
    super();
  }

  get used(): number {
    return this._used;
  }

  get remaining(): number {
    return Math.max(0, this.max - this._used);
  }

  ratio(): number {
    return this._used / this.max;
  }

  level(): BudgetLevel {
    const r = this.ratio();
    if (r >= 0.9) return 'red';
    if (r >= 0.7) return 'yellow';
    return 'green';
  }

  add(tokens: number): void {
    if (tokens <= 0) return;
    this._used += tokens;
    const lvl = this.level();
    this.emit('change', this._used, this.max, lvl);
    if (lvl === 'yellow' && !this._yellowTripped) {
      this._yellowTripped = true;
      this.emit('yellow', this._used, this.max);
    }
    if (lvl === 'red' && !this._redTripped) {
      this._redTripped = true;
      this.emit('red', this._used, this.max);
    }
  }

  reset(): void {
    this._used = 0;
    this._yellowTripped = false;
    this._redTripped = false;
    this.emit('change', 0, this.max, 'green');
  }

  /** 粗略估算字符串 token 数（English ~4 chars/token, 中文 ~2 chars/token）*/
  static estimate(text: string): number {
    const en = text.match(/[\x20-\x7e]/g)?.length ?? 0;
    const other = text.length - en;
    return Math.ceil(en / 4 + other / 2);
  }
}
