import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UniRoute | Üniversite Tercih ve Ulaşım",
  description:
    "Üniversite programlarını ara, tercih listesi oluştur ve kampüs ulaşım rotalarını incele.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
