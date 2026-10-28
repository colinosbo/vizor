import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { db } from "./db";
import { AppError } from "./errors";
export const selfHost = () => process.env.SELF_HOST !== "false";
export function checkRequest(request: Request) {
  const origin = new URL(process.env.APP_ORIGIN ?? "http://127.0.0.1:3000");
  if (request.headers.get("host") !== origin.host)
    throw new AppError(
      "host",
      "This host is not allowed. Open the configured local address.",
      403,
    );
  const suppliedOrigin = request.headers.get("origin");
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (suppliedOrigin !== null && suppliedOrigin !== origin.origin)
  )
    throw new AppError("origin", "Cross-site requests are not allowed.", 403);
  if (
    selfHost() &&
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  )
    throw new AppError(
      "configuration",
      "Self-host mode must use a loopback address.",
      503,
    );
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    if (request.headers.get("origin") !== origin.origin)
      throw new AppError(
        "origin",
        "This request must come from your Vizor workspace.",
        403,
      );
    if (request.headers.get("sec-fetch-site") === "cross-site")
      throw new AppError("origin", "Cross-site requests are not allowed.", 403);
  }
}
export async function rateLimit(identity: string, limit: number, seconds = 60) {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const id = createHash("sha256").update(`${identity}:${bucket}`).digest("hex");
  const row = await db.rateLimit.upsert({
    where: { id },
    create: { id, expiresAt: new Date((bucket + 1) * seconds * 1000) },
    update: { count: { increment: 1 } },
  });
  if (row.count > limit)
    throw new AppError(
      "rate_limited",
      "Too many requests. Please wait a moment and try again.",
      429,
    );
  await db.rateLimit.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 3600_000) } },
  });
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function sessionToken(request: Request) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("vizor_session="))
    ?.slice(14);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function owner(request: Request) {
  if (selfHost())
    return db.user.upsert({
      where: { id: "local-owner" },
      create: { id: "local-owner", email: "owner@vizor.local" },
      update: {},
      select: { id: true, email: true },
    });
  const token = sessionToken(request);
  if (!token)
    throw new AppError("unauthorized", "Sign in to open your workspace.", 401);
  const session = await db.session.findUnique({
    where: { id: hash(token) },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!session || session.expiresAt.getTime() <= Date.now())
    throw new AppError(
      "unauthorized",
      "Your session has expired. Please sign in again.",
      401,
    );
  return session.user;
}
export async function authenticate(
  email: string,
  password: string,
  register: boolean,
) {
  if (selfHost())
    throw new AppError(
      "auth_disabled",
      "Signup is disabled in self-host mode.",
      403,
    );
  await rateLimit("auth:all", 30, 900);
  await rateLimit(`auth:${email}`, 8, 900);
  let user = await db.user.findUnique({ where: { email } });
  if (register) {
    if (user)
      throw new AppError(
        "registration",
        "Unable to create this account. Try signing in instead.",
        400,
      );
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
    try {
      user = await db.user.create({ data: { email, passwordHash } });
    } catch {
      throw new AppError(
        "registration",
        "Unable to create this account. Try signing in instead.",
        400,
      );
    }
  } else {
    // Verify a real hash even for unknown users to avoid the obvious timing oracle.
    const candidate = user?.passwordHash ?? (await dummyHash());
    if (!(await argon2.verify(candidate, password)) || !user?.passwordHash)
      throw new AppError("credentials", "Email or password is incorrect.", 401);
  }
  if (!user)
    throw new AppError("credentials", "Email or password is incorrect.", 401);
  const token = randomBytes(32).toString("hex");
  await db.session.create({
    data: {
      id: hash(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + 7 * 86400_000),
    },
  });
  return token;
}
let dummy: Promise<string> | undefined;
function dummyHash() {
  return (dummy ??= argon2.hash(randomBytes(32).toString("hex"), {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  }));
}
export function cookie(token: string, clear = false) {
  const secure = (process.env.APP_ORIGIN ?? "").startsWith("https:")
    ? "; Secure"
    : "";
  return `vizor_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 604800}${secure}`;
}
export async function logout(request: Request) {
  const token = sessionToken(request);
  if (token) await db.session.deleteMany({ where: { id: hash(token) } });
}
