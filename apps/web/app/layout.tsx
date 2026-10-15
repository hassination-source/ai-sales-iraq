import type { Metadata } from "next";
import "./globals.css";
import { getLang } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Sales Iraq",
  description: "AI sales workspace for Iraqi businesses",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await getLang();
  return (
    <html lang={lang === "ar" ? "ar-IQ" : "en"} dir={lang === "ar" ? "rtl" : "ltr"}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
