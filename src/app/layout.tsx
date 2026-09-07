import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SAOS-DEX — הבורסה הריבונית של הרשת",
  description:
    "בורסה ריבונית אוטונומית: ספר-הזמנות דטרמיניסטי, בריכות 30bps, ארנת-חיילים עם שער-שוליים, חותמים מעוגנים וסולם-ערך מגובה. מורשת saos-dex + grid98.",
  other: {
    // UI Nuclear Override: אפס-הסתמכות על cache ישן — הדפדפן תמיד מבקש גרסה-חיה
    "Cache-Control": "no-store, must-revalidate",
    Pragma: "no-cache",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100 antialiased">
        {children}
      </body>
    </html>
  );
}
