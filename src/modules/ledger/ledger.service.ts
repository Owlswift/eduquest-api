import { BadRequestException, Injectable } from '@nestjs/common';
import { LedgerCurrency, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { levelForXp, xpToReachLevel } from '../gamification/levels';

type Db = Prisma.TransactionClient;

export interface GrantInput {
  userId: string;
  /** Positive amounts only; omit or 0 to skip that currency. */
  xp?: number;
  coins?: number;
  /** Short machine-readable cause, e.g. `quiz`, `welcome_bonus`. */
  reason: string;
  /**
   * Uniquely identifies this award (e.g. `welcome_bonus:<userId>`). A second
   * grant with the same key is a no-op, so retries and replays can never pay
   * twice. The XP and coin rows get `:xp` / `:coin` appended.
   */
  key: string;
  refType?: string;
  refId?: string;
}

export interface GrantResult {
  /** False when every requested row was already recorded under this key. */
  applied: boolean;
  xp: number;
  coins: number;
  /** Set when this grant carried the student into a higher level. */
  levelUp?: { from: number; to: number };
}

export type LevelUpListener = (event: { userId: string; from: number; to: number }) => void | Promise<void>;

/**
 * The only place `User.xp` / `User.coins` are changed. Every change is a
 * [LedgerEntry] row written in the same transaction as the balance update,
 * so the balances are always the sum of the ledger and every coin is
 * traceable (PRODUCT.md §20.5).
 */
@Injectable()
export class LedgerService {
  private levelUpListeners: LevelUpListener[] = [];

  constructor(private prisma: PrismaService) {}

  /** Register a callback for level-ups (notifications, achievements). It runs
   *  after the grant's own database work; failures in a listener never fail
   *  the grant. */
  onLevelUp(listener: LevelUpListener): void {
    this.levelUpListeners.push(listener);
  }

  /**
   * Credit XP and/or coins exactly once per `key`. Pass `tx` to run inside a
   * caller's transaction (so e.g. a state change and its award commit
   * together); otherwise a transaction is opened here.
   */
  async grant(input: GrantInput, tx?: Db): Promise<GrantResult> {
    const run = (db: Db) => this.grantIn(db, input);
    if (tx) return run(tx); // the caller announces any level-up once it commits
    const result = await this.prisma.$transaction(run);
    if (result.levelUp) this.announceLevelUp(input.userId, result.levelUp);
    return result;
  }

  /** Folds the level-ups of several grants made in one transaction into one
   *  event (first `from`, last `to`). */
  static mergeLevelUps(results: GrantResult[]): GrantResult['levelUp'] {
    const ups = results.map((r) => r.levelUp).filter((u): u is { from: number; to: number } => !!u);
    return ups.length ? { from: ups[0].from, to: ups[ups.length - 1].to } : undefined;
  }

  /** Tell listeners a student levelled up. Call it AFTER the transaction that
   *  granted the XP has committed (grant() does this itself when it owns the
   *  transaction). */
  announceLevelUp(userId: string, e: { from: number; to: number }) {
    for (const listener of this.levelUpListeners) {
      Promise.resolve()
        .then(() => listener({ userId, ...e }))
        .catch(() => undefined);
    }
  }

  /**
   * Debit coins, failing (without changing anything) if the balance is too
   * low. The balance check and the decrement are one conditional UPDATE, so
   * concurrent spends can't overdraw. Resolves to the remaining balance.
   */
  async spendCoins(
    input: { userId: string; coins: number; reason: string; key: string; refType?: string; refId?: string },
    tx?: Db,
  ): Promise<{ coins: number }> {
    if (!Number.isInteger(input.coins) || input.coins <= 0) {
      throw new BadRequestException('Invalid amount');
    }
    const run = async (db: Db) => {
      // The conditional UPDATE below takes the row lock first, so spends
      // already lock in the same order as grants.
      const updated = await db.user.updateMany({
        where: { id: input.userId, coins: { gte: input.coins } },
        data: { coins: { decrement: input.coins } },
      });
      if (updated.count === 0) {
        throw new BadRequestException('Not enough coins for this reward');
      }
      await db.ledgerEntry.create({
        data: {
          userId: input.userId,
          currency: LedgerCurrency.COIN,
          amount: -input.coins,
          reason: input.reason,
          refType: input.refType,
          refId: input.refId,
          idempotencyKey: `${input.key}:coin`,
        },
      });
      const user = await db.user.findUniqueOrThrow({
        where: { id: input.userId },
        select: { coins: true },
      });
      return { coins: user.coins };
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /** XP of one reason already credited since `since` - for daily caps. */
  async sumSince(userId: string, currency: LedgerCurrency, reason: string, since: Date): Promise<number> {
    const agg = await this.prisma.ledgerEntry.aggregate({
      where: { userId, currency, reason, createdAt: { gte: since } },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  private async grantIn(db: Db, input: GrantInput): Promise<GrantResult> {
    const xp = Math.max(0, Math.trunc(input.xp ?? 0));
    const coins = Math.max(0, Math.trunc(input.coins ?? 0));
    let appliedXp = 0;
    let appliedCoins = 0;

    // Take the student's row lock before anything else. Inserting a ledger row
    // and then updating the balance, in two transactions for the same student
    // at once, otherwise interleaves into a deadlock. Same-student grants now
    // queue here, in one order.
    if (xp > 0 || coins > 0) {
      await db.$queryRaw`SELECT 1 FROM "User" WHERE id = ${input.userId} FOR NO KEY UPDATE`;
    }

    // createMany + skipDuplicates compiles to INSERT .. ON CONFLICT DO
    // NOTHING: a replayed key inserts nothing (count 0) and, unlike a
    // thrown unique violation, doesn't abort the surrounding transaction.
    for (const [currency, amount, suffix] of [
      [LedgerCurrency.XP, xp, 'xp'],
      [LedgerCurrency.COIN, coins, 'coin'],
    ] as const) {
      if (amount === 0) continue;
      const inserted = await db.ledgerEntry.createMany({
        data: [
          {
            userId: input.userId,
            currency,
            amount,
            reason: input.reason,
            refType: input.refType,
            refId: input.refId,
            idempotencyKey: `${input.key}:${suffix}`,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        if (currency === LedgerCurrency.XP) appliedXp = amount;
        else appliedCoins = amount;
      }
    }

    let levelUp: GrantResult['levelUp'];
    if (appliedXp > 0 || appliedCoins > 0) {
      const user = await db.user.update({
        where: { id: input.userId },
        data: {
          ...(appliedXp > 0 && { xp: { increment: appliedXp } }),
          ...(appliedCoins > 0 && { coins: { increment: appliedCoins } }),
        },
        select: { xp: true, level: true },
      });
      // The level follows the XP total in the same transaction, so the two
      // can never disagree.
      const newLevel = levelForXp(user.xp);
      if (newLevel !== user.level) {
        await db.user.update({
          where: { id: input.userId },
          data: { level: newLevel, maxXp: xpToReachLevel(newLevel + 1) },
        });
        if (newLevel > user.level) levelUp = { from: user.level, to: newLevel };
      }
    }
    return { applied: appliedXp > 0 || appliedCoins > 0, xp: appliedXp, coins: appliedCoins, levelUp };
  }
}
