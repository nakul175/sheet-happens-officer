import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const publicSans = localFont({
  src: [
    { path: "./fonts/PublicSans-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/PublicSans-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/PublicSans-SemiBold.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-public-sans",
  display: "swap",
  adjustFontFallback: "Arial",
});

export const metadata: Metadata = {
  title: "Sheet Happens Officer",
  description: "Work manager for the APLYD team",
  icons: { icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }], apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "SHO", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#2c2f71",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={publicSans.variable}>
      <body>{children}</body>
    </html>
  );
}
