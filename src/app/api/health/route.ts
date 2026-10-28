import { checkRequest } from "@/lib/server/security";
import { safeError } from "@/lib/server/errors";
import { version } from "../../../../package.json";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    checkRequest(request);
    return Response.json(
      { app: "vizor", status: "ok", version },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const safe = safeError(error);
    return Response.json({ error: safe.message }, { status: safe.status });
  }
}
