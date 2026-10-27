import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./council/council.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Council vote",
  description: "A room votes on stickies. Each council session has its own admin key.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="council-page">
      <body>{children}</body>
    </html>
  );
}
