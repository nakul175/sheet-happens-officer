// Next loads client instrumentation before app hydration on public and signed-in pages.
// Install once here so a later sheet can handle Back before the router unmounts it.
import { initializeOverlayPopstate } from "@/lib/overlay-popstate";
initializeOverlayPopstate();
