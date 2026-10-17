import type { MetadataRoute } from "next";

// SHO-US-10.10: lets people add the app to their Home Screen. No service worker, so nothing private is ever cached on the device.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sheet Happens Officer",
    short_name: "SHO",
    description: "Work manager for the APLYD team",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#2c2f71",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
