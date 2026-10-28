import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
export default defineConfig({resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}},test:{include:['src/lib/holy-sheet-checklist-tasks.test.ts','src/lib/suite-oauth-holy-sheet.test.ts'],fileParallelism:false}});
