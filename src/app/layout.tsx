import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Public Sans (OFL, see ./fonts/OFL.txt), variable latin subset from @fontsource-variable/public-sans 5.3.0.
// Loaded locally so builds need no network access to Google Fonts (APL-2639).
const publicSans = localFont({
  src: "./fonts/PublicSans-Variable-latin.woff2",
  variable: "--font-public-sans",
  weight: "400 600",
  style: "normal",
  display: "swap",
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
