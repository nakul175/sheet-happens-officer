import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const lato = localFont({
  src: [
    { path: "../../public/fonts/Lato-Regular.ttf", weight: "400", style: "normal" },
    { path: "../../public/fonts/Lato-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-lato",
  display: "swap",
  adjustFontFallback: "Arial",
});

export const metadata: Metadata = {
  title: "Tasks by aplyd",
  description: "Work manager for the APLYD team",
  icons: { icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }], apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "Tasks", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#2c2f71",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={lato.variable}>
      <body>{children}</body>
    </html>
  );
}
