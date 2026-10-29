import { NextResponse, type NextRequest } from "next/server";
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const development = process.env.NODE_ENV !== "production";
  // xterm creates per-terminal style elements at runtime. Script execution stays
  // nonce-protected; only the local desktop terminal surface allows those styles.
  const terminalStyles = process.env.VIZOR_TERMINALS === "1";
  const frameAncestors =
    request.nextUrl.pathname === "/intro/index.html" ? "'self'" : "'none'";
  const policy = `default-src 'self'; script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ""}; style-src 'self'${development || terminalStyles ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors ${frameAncestors}; form-action 'self'`;
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
