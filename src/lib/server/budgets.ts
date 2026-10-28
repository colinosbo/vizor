import { db } from "./db";
import { AppError } from "./errors";
import { getProvider, providers } from "../providers";
import { modelPrice } from "./pricing";
import { audit } from "./audit";
import { publish } from "./events";
import type {
  SendInput,
  SendResult,
  StreamEvent,
  Usage,
} from "../providers/types";
export const periodNow = (date = new Date()) => date.toISOString().slice(0, 7);
export const usd = (value: bigint) => Number(value) / 1_000_000;
export const micros = (value: number) =>
  BigInt(Math.ceil(value * 1_000_000 - 1e-8));
type Source = {
  source: "chat" | "orchestrator" | "connection";
  referenceId?: string;
};
const incomplete: Usage = {
  inputTokens: null,
  outputTokens: null,
  complete: false,
};
function quote(rate: [number, number], input: number, output: number) {
  return BigInt(Math.ceil(input * rate[0] + output * rate[1]));
}
export async function reserveSpend(
  userId: string,
  provider: string,
  input: SendInput,
  source: Source,
) {
  try {
    return await prepareSpend(userId, provider, input, source);
  } catch (error) {
    if (error instanceof AppError)
      await audit(
        userId,
        "budget.blocked",
        source.referenceId ?? null,
        { provider, model: input.model, reason: error.code },
        { actor: "system" },
      );
    throw error;
  }
}
async function prepareSpend(
  userId: string,
  provider: string,
  input: SendInput,
  source: Source,
) {
  input.signal?.throwIfAborted();
  const period = periodNow();
  const rate = modelPrice(provider, input.model);
  const policy = await db.providerBudget.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  const protectedCall = policy?.limitMicros != null;
  let inputTokens: number;
  if (protectedCall) {
    const month = await db.budgetMonth.findUnique({
      where: { userId_provider_period: { userId, provider, period } },
    });
    if (
      policy.limitMicros! <=
      (month?.spentMicros ?? 0n) + (month?.reservedMicros ?? 0n)
    )
      throw new AppError(
        "budget_exhausted",
        "This provider’s monthly budget is exhausted or reserved by running requests. No new generation was started.",
        409,
      );
    if (month?.unknownCalls)
      throw new AppError(
        "budget_unknown",
        "Reconcile this month’s unpriced usage in Spending limits before making a protected request.",
        409,
      );
    const adapter = getProvider(provider);
    if (!rate || !adapter.countTokens)
      throw new AppError(
        "budget_unpriced",
        "This model has no verified price/token counter for spending protection. Choose a priced model or explicitly remove the optional limit.",
        409,
      );
    const counted = await adapter.countTokens(input);
    if (!Number.isSafeInteger(counted) || counted < 0 || counted > 10_000_000)
      throw new AppError(
        "token_count",
        "Input tokens could not be verified. No generation was started.",
        503,
      );
    inputTokens = counted + Math.ceil(counted / 10) + 256;
  } else
    inputTokens =
      Buffer.byteLength(
        JSON.stringify({
          system: input.system,
          messages: input.messages,
          tools: input.tools,
        }),
        "utf8",
      ) + 4096;
  input.signal?.throwIfAborted();
  const amount = rate ? quote(rate, inputTokens, input.maxTokens) : 0n;
  const entry = await db.$transaction(async (tx) => {
    const latest = await tx.providerBudget.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    const month = await tx.budgetMonth.upsert({
      where: { userId_provider_period: { userId, provider, period } },
      create: { userId, provider, period },
      update: {},
    });
    if (latest?.limitMicros != null) {
      if (!protectedCall || !rate)
        throw new AppError(
          "budget_changed",
          "The spending policy changed while preparing this request. Please retry.",
          409,
        );
      if (month.unknownCalls)
        throw new AppError(
          "budget_unknown",
          "Reconcile unpriced usage in Spending limits before continuing.",
          409,
        );
      if (
        month.spentMicros + month.reservedMicros + amount >
        latest.limitMicros
      )
        throw new AppError(
          "budget_exhausted",
          "The request’s maximum cost does not fit the remaining monthly budget. Reduce output tokens or adjust the limit.",
          409,
        );
    }
    await tx.budgetMonth.update({
      where: { id: month.id },
      data: { reservedMicros: { increment: amount } },
    });
    return tx.spendEntry.create({
      data: {
        userId,
        provider,
        model: input.model,
        period,
        ...source,
        quotedMicros: amount,
        inputRate: rate?.[0],
        outputRate: rate?.[1],
      },
    });
  });
  publish(userId);
  return entry.id;
}
export async function settleSpend(
  id: string,
  usage: Usage = incomplete,
  error?: unknown,
  notStarted = false,
) {
  const noCharge =
    notStarted ||
    (error instanceof AppError &&
      ["invalid_key", "billing", "rate_limited", "model_unavailable"].includes(
        error.code,
      ));
  const result = await db.$transaction(async (tx) => {
    const entry = await tx.spendEntry.findUnique({ where: { id } });
    if (!entry || entry.status !== "reserved") return null;
    const reported =
      Number.isSafeInteger(usage.inputTokens) &&
      Number.isSafeInteger(usage.outputTokens) &&
      usage.inputTokens! >= 0 &&
      usage.outputTokens! >= 0 &&
      usage.complete;
    const priced = entry.inputRate != null && entry.outputRate != null;
    const charged = noCharge
      ? 0n
      : reported && priced
        ? quote(
            [entry.inputRate!, entry.outputRate!],
            usage.inputTokens!,
            usage.outputTokens!,
          )
        : entry.quotedMicros;
    const unknown = !noCharge && !priced;
    await tx.spendEntry.update({
      where: { id },
      data: {
        status: unknown ? "unknown" : "settled",
        chargedMicros: charged,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimated: !reported && !noCharge,
        settledAt: new Date(),
      },
    });
    await tx.budgetMonth.update({
      where: {
        userId_provider_period: {
          userId: entry.userId,
          provider: entry.provider,
          period: entry.period,
        },
      },
      data: {
        reservedMicros: { decrement: entry.quotedMicros },
        spentMicros: { increment: charged },
        unknownCalls: { increment: unknown ? 1 : 0 },
      },
    });
    if (charged > entry.quotedMicros)
      await audit(
        entry.userId,
        "budget.quote_exceeded",
        entry.referenceId,
        {
          provider: entry.provider,
          quoted: usd(entry.quotedMicros),
          charged: usd(charged),
        },
        { actor: "system" },
        tx,
      );
    return entry.userId;
  });
  if (result) publish(result);
}
export async function meteredSend(
  userId: string,
  provider: string,
  input: SendInput,
  source: Source,
): Promise<SendResult> {
  const id = await reserveSpend(userId, provider, input, source);
  let result: SendResult | undefined;
  let error: unknown;
  try {
    input.signal?.throwIfAborted();
    result = await getProvider(provider).send(input);
    return result;
  } catch (e) {
    error = e;
    throw e;
  } finally {
    await settleSpend(id, result?.usage, error);
  }
}
export async function* meteredStream(
  userId: string,
  provider: string,
  input: SendInput,
  source: Source,
): AsyncGenerator<StreamEvent> {
  const id = await reserveSpend(userId, provider, input, source);
  let usage: Usage = { ...incomplete };
  let error: unknown;
  try {
    input.signal?.throwIfAborted();
    for await (const event of getProvider(provider).stream(input)) {
      if (event.type === "usage") usage = event.usage;
      yield event;
    }
  } catch (e) {
    error = e;
    throw e;
  } finally {
    await settleSpend(id, usage, error);
  }
}
export async function recoverSpending() {
  for (const entry of await db.spendEntry.findMany({
    where: { status: "reserved" },
    select: { id: true },
  }))
    await settleSpend(entry.id);
}
export async function budgetViews(userId: string) {
  const period = periodNow();
  const [policies, months] = await Promise.all([
    db.providerBudget.findMany({ where: { userId } }),
    db.budgetMonth.findMany({ where: { userId, period } }),
  ]);
  return providers.map((provider) => {
    const policy = policies.find((p) => p.provider === provider.id),
      month = months.find((m) => m.provider === provider.id);
    const spent = usd(month?.spentMicros ?? 0n),
      reserved = usd(month?.reservedMicros ?? 0n),
      limit = policy?.limitMicros == null ? null : usd(policy.limitMicros);
    return {
      provider: provider.id,
      label: provider.label,
      period,
      limit,
      spent,
      reserved,
      unknownCalls: month?.unknownCalls ?? 0,
      warning: limit != null && spent + reserved >= limit * 0.8,
      blocked:
        limit != null && (spent + reserved >= limit || !!month?.unknownCalls),
      pricedModels: provider.fallbackModels
        .filter((m) => modelPrice(provider.id, m.id))
        .map((m) => m.id),
    };
  });
}
export async function setBudget(
  userId: string,
  provider: string,
  limit: number | null,
  openingBalance?: number,
) {
  getProvider(provider);
  const period = periodNow();
  const limitMicros = limit == null ? null : micros(limit);
  await db.$transaction(async (tx) => {
    if (
      await tx.spendEntry.count({
        where: { userId, provider, status: "reserved" },
      })
    )
      throw new AppError(
        "budget_busy",
        "Wait for this provider’s running requests to finish, or stop them, before changing spending settings.",
        409,
      );
    const month = await tx.budgetMonth.upsert({
      where: { userId_provider_period: { userId, provider, period } },
      create: { userId, provider, period },
      update: {},
    });
    if (openingBalance !== undefined) {
      const baseline = micros(openingBalance);
      if (baseline < month.spentMicros)
        throw new AppError(
          "opening_balance",
          "The opening balance cannot be lower than the spending already recorded by Vizor.",
        );
      if (baseline > month.spentMicros)
        await tx.spendEntry.create({
          data: {
            userId,
            provider,
            model: "Opening balance",
            source: "adjustment",
            period,
            status: "settled",
            chargedMicros: baseline - month.spentMicros,
            settledAt: new Date(),
            estimated: true,
          },
        });
      await tx.budgetMonth.update({
        where: { id: month.id },
        data: { spentMicros: baseline, unknownCalls: 0 },
      });
      await tx.spendEntry.updateMany({
        where: { userId, provider, period, status: "unknown" },
        data: { status: "reconciled" },
      });
      await audit(
        userId,
        "budget.reconciled",
        provider,
        {
          period,
          openingBalance,
          previousSpent: usd(month.spentMicros),
          previousUnknown: month.unknownCalls,
        },
        {},
        tx,
      );
    }
    await tx.providerBudget.upsert({
      where: { userId_provider: { userId, provider } },
      create: { userId, provider, limitMicros },
      update: { limitMicros },
    });
    await audit(userId, "budget.updated", provider, { period, limit }, {}, tx);
  });
  publish(userId);
}
