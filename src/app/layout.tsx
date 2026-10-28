import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Vizor — Your agent workspace",
  description:
    "A private workspace for focused conversations with your AI agents.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
