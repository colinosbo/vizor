import type { NextConfig } from "next";
const config: NextConfig = {
  output: process.env.VIZOR_PORTABLE_BUILD === "1" ? "standalone" : undefined,
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/better-sqlite3/build/Release/*.node",
      "./node_modules/argon2/prebuilds/**/*",
      "./node_modules/argon2/build/Release/*.node",
    ],
  },
  poweredByHeader: false,
  serverExternalPackages: ["argon2", "better-sqlite3"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default config;
